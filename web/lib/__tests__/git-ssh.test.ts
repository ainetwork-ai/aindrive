// Git over SSH (lib/git-ssh/*, lib/sso-ssh-keys.ts, lib/drive-gate.ts): the
// command line, the repo path, the AIN SSO key directory client + cache, the
// key → user resolution, the host key, the relay against a fake agent pipe, and
// the user-id gate's parity with the HTTP gate. The ssh handshake itself is
// covered end to end with real `ssh`/`git` clients (PR harness), not here.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";

// requireDriveRole falls back to the cookie jar for an anonymous request; there
// is no Next request scope here, so give it an empty jar.
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-git-ssh-"));
process.env.AINDRIVE_SESSION_SECRET = "git-ssh-test-secret-0123456789abcdef";
process.env.AINDRIVE_PUBLIC_URL = "https://drive.example.test";
const ISSUER = "https://sso.example.test";
process.env.AINDRIVE_SSO_ISSUER = ISSUER;
process.env.AINDRIVE_SSO_CLIENT_ID = "app_aindrive";
process.env.AINDRIVE_SSO_CLIENT_SECRET = "s3cret";

const { db } = await import("../db.js");
const { parseGitCommand, parseRepoTarget, minRoleFor } = await import("../git-ssh/command");
const { resolveSshIdentity, publicKeyBlobOf, recordMatchesKey } = await import("../git-ssh/identity");
const sshKeys = await import("../sso-ssh-keys");
const { toOpenSshEd25519, loadOrCreateHostKey } = await import("../git-ssh/host-key");
const { relayGitExec, GIT_SSH_MAX_PER_DRIVE } = await import("../git-ssh/relay");
const { gateDriveRoleForUser } = await import("../drive-gate");
const { requireDriveRole } = await import("../require-access");
const { appCredentials } = await import("../sso/config");
const orgs = await import("../orgs.js");

// ── fixtures ────────────────────────────────────────────────────────────────
const ed = () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const raw = Buffer.from(jwk.x, "base64url");
  const len = Buffer.alloc(4); len.writeUInt32BE(11, 0);
  const rawLen = Buffer.alloc(4); rawLen.writeUInt32BE(32, 0);
  const blob = Buffer.concat([len, Buffer.from("ssh-ed25519"), rawLen, raw]);
  const fp = "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
  return { blob, fp, line: `ssh-ed25519 ${blob.toString("base64")} test` };
};
const KEY = { owner: ed(), viewer: ed(), blocked: ed(), unlinked: ed(), stranger: ed() };
const records = new Map<string, { subject: string; public_key: string }>([
  [KEY.owner.fp, { subject: "acc_owner", public_key: KEY.owner.line }],
  [KEY.viewer.fp, { subject: "acc_viewer", public_key: KEY.viewer.line }],
  [KEY.blocked.fp, { subject: "acc_blocked", public_key: KEY.blocked.line }],
  [KEY.unlinked.fp, { subject: "acc_unlinked", public_key: KEY.unlinked.line }],
]);
const directory = {
  calls: 0,
  async byFingerprint(fp: string) { directory.calls++; const r = records.get(fp); return r ? { ...r, fingerprint: fp, key_type: "ssh-ed25519" } : null; },
  async bySubject() { return []; },
};

beforeAll(() => {
  const u = db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)");
  for (const id of ["u-owner", "u-viewer", "u-blocked", "u-other"]) u.run(id, `${id}@example.test`, id, "x");
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)").run("d-comcom", "u-owner", "ComCom", "h", "sec");
  const ident = db.prepare("INSERT INTO sso_identities (issuer, subject, user_id, link_method, linked_at) VALUES (?,?,?,?,?)");
  ident.run(ISSUER, "acc_owner", "u-owner", "jit", 1); ident.run(ISSUER, "acc_viewer", "u-viewer", "jit", 1); ident.run(ISSUER, "acc_blocked", "u-blocked", "jit", 1);
  const mem = db.prepare(`INSERT INTO sso_memberships (issuer, org_id, subject, user_id, org_slug, org_name, status, app_role, groups_json, applied_version, updated_at)
    VALUES (?, 'org_comcom', ?, ?, 'comcom', 'ComCom', ?, 'member', '[]', 1, ?)`);
  mem.run(ISSUER, "acc_owner", "u-owner", "active", 1); mem.run(ISSUER, "acc_viewer", "u-viewer", "active", 1); mem.run(ISSUER, "acc_blocked", "u-blocked", "suspended", 1);
  orgs.shareDriveWithOrg({ driveId: "d-comcom", issuer: ISSUER, orgId: "org_comcom", role: "viewer", actor: "operator", via: "operator" });
});

// ── command + path ──────────────────────────────────────────────────────────
describe("parseGitCommand", () => {
  it("accepts exactly git-upload-pack / git-receive-pack with one quoted path", () => {
    expect(parseGitCommand("git-upload-pack 'comcom/clef-artwork-search'")).toEqual({ service: "upload-pack", rawPath: "comcom/clef-artwork-search" });
    expect(parseGitCommand("git-receive-pack '/comcom/x.git'")).toEqual({ service: "receive-pack", rawPath: "/comcom/x.git" });
    expect(parseGitCommand("git upload-pack d/abcdef12/x")).toEqual({ service: "upload-pack", rawPath: "d/abcdef12/x" });
  });
  it("refuses everything else", () => {
    for (const c of ["ls", "git-upload-pack", "git-upload-pack 'a' 'b'", "git-upload-pack --strict 'a'", "git-upload-archive 'a'", "sh -c 'x'", "git-upload-pack 'a'; ls", "git-upload-pack ''", "", "git-upload-pack 'a' && rm -rf /"]) {
      expect(parseGitCommand(c), c).toBeNull();
    }
  });
});

describe("parseRepoTarget", () => {
  it("splits <slug>/<repo> and d/<driveId>/<repo>, dropping / and .git", () => {
    expect(parseRepoTarget("comcom/clef-artwork-search")).toEqual({ kind: "slug", slug: "comcom", repo: "clef-artwork-search" });
    expect(parseRepoTarget("/comcom/sub/dir/repo.git/")).toEqual({ kind: "slug", slug: "comcom", repo: "sub/dir/repo" });
    expect(parseRepoTarget("d/abcdef123456/proj.git")).toEqual({ kind: "drive", driveId: "abcdef123456", repo: "proj" });
  });
  it("refuses traversal, control characters, a slug alone, and a bad drive id", () => {
    for (const p of ["comcom", "comcom/../etc", "comcom/./x", "comcom//x", "d/abcdef123456", "d/bad id/x", "d/x", "com\x00com/x", "comcom/a\\b", ""]) {
      expect(parseRepoTarget(p), p).toBeNull();
    }
  });
  it("maps services to the HTTP gate's roles", () => {
    expect(minRoleFor("upload-pack")).toBe("viewer");
    expect(minRoleFor("receive-pack")).toBe("editor");
  });
});

// ── key directory client ────────────────────────────────────────────────────
describe("sso-ssh-keys", () => {
  it("computes the OpenSSH SHA256 fingerprint", () => {
    expect(sshKeys.sshFingerprint(KEY.owner.blob)).toBe(KEY.owner.fp);
    expect(sshKeys.isSshFingerprint(KEY.owner.fp)).toBe(true);
    expect(sshKeys.isSshFingerprint("MD5:aa:bb")).toBe(false);
  });

  it("GETs the lookup with client_secret_basic and maps 200 / 404 / other", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      seen.push({ url: u, auth: (init?.headers as Record<string, string>)?.authorization ?? null });
      if (u.includes("/lookup?fingerprint=" + encodeURIComponent(KEY.owner.fp))) {
        return new Response(JSON.stringify({ subject: "acc_owner", email: "o@x", name: "O", key_type: "ssh-ed25519", public_key: KEY.owner.line, fingerprint: KEY.owner.fp, title: "laptop", created_at: "2026-01-01T00:00:00Z" }), { status: 200 });
      }
      if (u.includes("/lookup?")) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      if (u.includes("/by-subject?subject=acc_owner")) return new Response(JSON.stringify({ subject: "acc_owner", keys: [{ key_type: "ssh-ed25519", public_key: KEY.owner.line, fingerprint: KEY.owner.fp, title: "laptop", created_at: null }] }), { status: 200 });
      return new Response("nope", { status: 503 });
    }) as unknown as typeof fetch;
    const dir = sshKeys.createSsoSshKeyDirectory({ issuer: ISSUER + "/", clientId: "app_aindrive", clientSecret: "s3cret" }, fetchImpl);
    const rec = await dir.byFingerprint(KEY.owner.fp);
    expect(rec?.subject).toBe("acc_owner");
    expect(seen[0].url).toBe(`${ISSUER}/api/apps/ssh-keys/lookup?fingerprint=${encodeURIComponent(KEY.owner.fp)}`);
    expect(seen[0].auth).toBe("Basic " + Buffer.from("app_aindrive:s3cret").toString("base64"));
    expect(await dir.byFingerprint(KEY.stranger.fp)).toBeNull();
    expect(await dir.byFingerprint("garbage")).toBeNull(); // never sent
    expect((await dir.bySubject("acc_owner")).map((k) => k.fingerprint)).toEqual([KEY.owner.fp]);
    await expect(dir.bySubject("acc_zzz")).rejects.toThrow(/503/);
  });

  it("refuses a record whose fingerprint is not the one asked about", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ subject: "acc_x", public_key: KEY.owner.line, fingerprint: KEY.viewer.fp }), { status: 200 })) as unknown as typeof fetch;
    const dir = sshKeys.createSsoSshKeyDirectory({ issuer: ISSUER, clientId: "a", clientSecret: "b" }, fetchImpl);
    expect(await dir.byFingerprint(KEY.owner.fp)).toBeNull();
  });

  it("caches positive and negative answers for at most 60 s, never errors", async () => {
    let now = 1_000_000;
    let calls = 0;
    let fail = false;
    const inner = {
      async byFingerprint(fp: string) { calls++; if (fail) throw new Error("down"); return fp === KEY.owner.fp ? { subject: "acc_owner", public_key: KEY.owner.line, fingerprint: fp, key_type: "ssh-ed25519" } : null; },
      async bySubject() { calls++; return []; },
    };
    const dir = sshKeys.cachedSshKeyDirectory(inner, 10 * 60_000, () => now); // asked for 10 min, capped at 60 s
    await dir.byFingerprint(KEY.owner.fp); await dir.byFingerprint(KEY.owner.fp);
    await dir.byFingerprint(KEY.stranger.fp); await dir.byFingerprint(KEY.stranger.fp);
    expect(calls).toBe(2);
    now += 59_000; await dir.byFingerprint(KEY.owner.fp); expect(calls).toBe(2);
    now += 2_000; await dir.byFingerprint(KEY.owner.fp); expect(calls).toBe(3);
    fail = true; now += 61_000;
    await expect(dir.byFingerprint(KEY.owner.fp)).rejects.toThrow("down");
    fail = false; await dir.byFingerprint(KEY.owner.fp); expect(calls).toBe(5); // the error was not cached
  });

  it("appCredentials needs issuer + client id + secret", () => {
    expect(appCredentials()).toEqual({ issuer: ISSUER, clientId: "app_aindrive", clientSecret: "s3cret" });
  });
});

// ── key → user ──────────────────────────────────────────────────────────────
describe("resolveSshIdentity", () => {
  const deps = { directory, issuer: ISSUER };
  it("maps a registered key to the linked, active account", async () => {
    const r = await resolveSshIdentity(KEY.owner.blob, deps);
    expect(r).toMatchObject({ ok: true, identity: { userId: "u-owner", subject: "acc_owner", fingerprint: KEY.owner.fp } });
  });
  it("refuses unknown, unlinked and blocked keys, and a record for another key", async () => {
    expect(await resolveSshIdentity(KEY.stranger.blob, deps)).toEqual({ ok: false, reason: "unknown_key" });
    expect(await resolveSshIdentity(KEY.unlinked.blob, deps)).toEqual({ ok: false, reason: "not_linked" });
    expect(await resolveSshIdentity(KEY.blocked.blob, deps)).toEqual({ ok: false, reason: "blocked" });
    const swapped = { ...deps, directory: { async byFingerprint() { return { subject: "acc_owner", public_key: KEY.viewer.line, fingerprint: KEY.owner.fp, key_type: "ssh-ed25519" }; }, async bySubject() { return []; } } };
    expect(await resolveSshIdentity(KEY.owner.blob, swapped)).toEqual({ ok: false, reason: "key_mismatch" });
    const gone = { ...deps, userRow: () => undefined };
    expect(await resolveSshIdentity(KEY.owner.blob, gone)).toEqual({ ok: false, reason: "no_account" });
  });
  it("key helpers", () => {
    expect(publicKeyBlobOf(KEY.owner.line)?.equals(KEY.owner.blob)).toBe(true);
    expect(publicKeyBlobOf("not a key")).toBeNull();
    expect(publicKeyBlobOf(`ssh-rsa ${KEY.owner.blob.toString("base64")}`)).toBeNull(); // type word ≠ blob's algorithm
    expect(recordMatchesKey({ subject: "s", public_key: KEY.owner.line, fingerprint: KEY.owner.fp, key_type: "ssh-ed25519" }, KEY.viewer.blob)).toBe(false);
  });
});

// ── host key ────────────────────────────────────────────────────────────────
describe("host key", () => {
  it("writes an OpenSSH Ed25519 key once (0600) that ssh2 parses and whose public half matches", async () => {
    const { utils } = (await import("ssh2")).default;
    const p = join(process.env.AINDRIVE_DATA_DIR!, "ssh_host_ed25519_key");
    const pem = loadOrCreateHostKey(p);
    expect(existsSync(p) && existsSync(p + ".pub")).toBe(true);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(loadOrCreateHostKey(p)).toBe(pem); // reused, not regenerated
    const parsed = utils.parseKey(pem);
    expect(parsed instanceof Error).toBe(false);
    const k = parsed as { type: string; getPublicSSH(): Buffer };
    expect(k.type).toBe("ssh-ed25519");
    expect(readFileSync(p + ".pub", "utf8").split(" ")[1]).toBe(k.getPublicSSH().toString("base64"));
  });
  it("encodes a given Node key pair faithfully", async () => {
    const { utils } = (await import("ssh2")).default;
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { privatePem, publicLine } = toOpenSshEd25519(privateKey, "c");
    const parsed = utils.parseKey(privatePem) as { getPublicSSH(): Buffer; sign(d: Buffer): Buffer | Error };
    const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
    expect(parsed.getPublicSSH().subarray(-32).toString("base64url")).toBe(x);
    expect(publicLine.startsWith("ssh-ed25519 ")).toBe(true);
    const sig = parsed.sign(Buffer.from("data"));
    expect(sig instanceof Error).toBe(false);
  });
});

// ── the user-id gate ↔ the HTTP gate ────────────────────────────────────────
describe("gateDriveRoleForUser", () => {
  it("grants the owner, the org viewer, refuses the rest exactly like requireDriveRole", async () => {
    const owner = await gateDriveRoleForUser("d-comcom", "proj", { min: "editor", userId: "u-owner" });
    expect("denied" in owner ? null : owner.role).toBe("owner");
    const viewerRead = await gateDriveRoleForUser("d-comcom", "proj", { min: "viewer", userId: "u-viewer" });
    expect("denied" in viewerRead ? null : viewerRead.role).toBe("viewer");
    expect(await gateDriveRoleForUser("d-comcom", "proj", { min: "editor", userId: "u-viewer" })).toEqual({ denied: true, status: 403, body: { error: "forbidden" } });
    expect(await gateDriveRoleForUser("d-comcom", "proj", { min: "viewer", userId: "u-other" })).toEqual({ denied: true, status: 403, body: { error: "forbidden" } });
    expect(await gateDriveRoleForUser("d-comcom", "proj", { min: "viewer", userId: null })).toEqual({ denied: true, status: 401, body: { error: "forbidden" } });
    expect(await gateDriveRoleForUser("d-comcom", ".aindrive/config.json", { min: "viewer", userId: "u-owner" })).toEqual({ denied: true, status: 403, body: { error: "reserved path" } });
    expect(await gateDriveRoleForUser("d-nope", "proj", { min: "viewer", userId: "u-owner" })).toEqual({ denied: true, status: 404, body: { error: "drive not found" } });
    // the suspended member holds nothing through the org (lib/orgs.js), as before
    expect(await gateDriveRoleForUser("d-comcom", "proj", { min: "viewer", userId: "u-blocked" })).toEqual({ denied: true, status: 403, body: { error: "forbidden" } });
  });

  it("requireDriveRole (HTTP front) answers the same statuses for the same cases", async () => {
    const { sign } = await import("../session");
    const req = async (userId: string | null) => new Request("https://drive.example.test/x", { headers: userId ? { authorization: `Bearer ${await sign(userId)}` } : {} });
    const status = async (path: string, min: "viewer" | "editor", userId: string | null, driveId = "d-comcom") => {
      const g = await requireDriveRole(driveId, path, { min, req: await req(userId) });
      return g instanceof Response ? g.status : "ok:" + g.role;
    };
    expect(await status("proj", "editor", "u-owner")).toBe("ok:owner");
    expect(await status("proj", "viewer", "u-viewer")).toBe("ok:viewer");
    expect(await status("proj", "editor", "u-viewer")).toBe(403);
    expect(await status("proj", "viewer", "u-other")).toBe(403);
    expect(await status("proj", "viewer", null)).toBe(401);
    expect(await status(".aindrive/config.json", "viewer", "u-owner")).toBe(403);
    expect(await status("proj", "viewer", "u-owner", "d-nope")).toBe(404);
  });
});

// ── relay against a fake agent pipe ─────────────────────────────────────────
type Handlers = { onStdout: (b: Buffer) => void; onStderr: (b: Buffer) => void; onExit: (e: { code: number | null; signal: string | null; error?: string }) => void };
function fakeChannel() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Cb = (...a: any[]) => void;
  const listeners: Record<string, Cb[]> = {};
  const out: Buffer[] = []; const err: string[] = []; const calls: string[] = [];
  const ch = {
    on(ev: string, cb: Cb) { (listeners[ev] ??= []).push(cb); return ch; },
    emit(ev: string, ...a: unknown[]) { for (const cb of listeners[ev] ?? []) cb(...a); },
    write(b: Buffer, cb?: () => void) { out.push(b); cb?.(); return true; },
    pause() { calls.push("pause"); }, resume() { calls.push("resume"); },
    end() { calls.push("end"); }, close() { calls.push("close"); }, exit(c: number) { calls.push("exit:" + c); },
    stderr: { write(b: Buffer | string) { err.push(String(b)); } },
    out, err, calls,
  };
  return ch;
}

describe("relayGitExec", () => {
  it("pipes stdin/stdout both ways, acks consumed bytes, passes the exit code", async () => {
    const ch = fakeChannel();
    const written: Buffer[] = []; const acks: number[] = []; let ended = false; let handlers!: Handlers;
    const open = async (_d: string, _t: unknown, h: Handlers) => {
      handlers = h;
      setTimeout(() => { h.onStdout(Buffer.from("advert")); }, 5);
      return {
        execId: "e", onDrain: null as null | (() => void), windowBytes: 1024,
        write(b: Uint8Array) { written.push(Buffer.from(b)); return true; }, inFlight: () => 0,
        ack(n: number) { acks.push(n); }, end() { ended = true; setTimeout(() => { h.onStdout(Buffer.from("PACK")); h.onExit({ code: 0, signal: null }); }, 5); },
        kill() {}, finished: false,
      };
    };
    const p = relayGitExec({ driveId: "d1", driveSecret: "s", repo: "r", service: "upload-pack", channel: ch, open: open as never });
    await new Promise((r) => setTimeout(r, 20));
    ch.emit("data", Buffer.from("want x"));
    ch.emit("end");
    const out = await p;
    expect(written.map(String)).toEqual(["want x"]);
    expect(ended).toBe(true);
    expect(Buffer.concat(ch.out).toString()).toBe("advertPACK");
    expect(acks).toEqual([6, 4]);
    expect(out).toMatchObject({ exit: 0, bytesIn: 6, bytesOut: 10 });
    expect(ch.calls.slice(-3)).toEqual(["exit:0", "end", "close"]);
    expect(handlers).toBeDefined();
  });

  it("reports refusals on stderr with exit 1: offline drive, missing repo, cap", async () => {
    const offline = fakeChannel();
    await relayGitExec({ driveId: "d1", driveSecret: "s", repo: "r", service: "upload-pack", channel: offline, open: (async () => { throw Object.assign(new Error("agent offline"), { status: 504 }); }) as never });
    expect(offline.err.join("")).toMatch(/drive is offline/); expect(offline.calls).toContain("exit:1");

    const missing = fakeChannel();
    await relayGitExec({ driveId: "d1", driveSecret: "s", repo: "r", service: "upload-pack", channel: missing, open: (async () => { throw new Error("not a git repository"); }) as never });
    expect(missing.err.join("")).toMatch(/repository not found/);

    const capped = fakeChannel();
    await relayGitExec({ driveId: "d1", driveSecret: "s", repo: "r", service: "upload-pack", channel: capped, maxPerDrive: 0, open: (async () => { throw new Error("must not be called"); }) as never });
    expect(capped.err.join("")).toMatch(/too many concurrent/);
    expect(GIT_SSH_MAX_PER_DRIVE).toBeGreaterThan(0);
  });

  it("receive-pack to a missing repo: git-init then retry (as over HTTP); upload-pack does not create", async () => {
    let inits = 0; let opens = 0;
    const open = async (_d: string, _t: unknown, h: Handlers) => {
      opens++;
      if (opens === 1) throw new Error("not a git repository");
      setTimeout(() => h.onExit({ code: 0, signal: null }), 5);
      return { execId: "e", onDrain: null, windowBytes: 1, write: () => true, inFlight: () => 0, ack() {}, end() {}, kill() {}, finished: false };
    };
    const ch = fakeChannel();
    const out = await relayGitExec({ driveId: "d1", driveSecret: "s", repo: "new", service: "receive-pack", channel: ch, open: open as never, init: async () => { inits++; } });
    expect(inits).toBe(1); expect(opens).toBe(2); expect(out.exit).toBe(0);

    inits = 0; opens = 0;
    const ch2 = fakeChannel();
    await relayGitExec({ driveId: "d1", driveSecret: "s", repo: "new", service: "upload-pack", channel: ch2, open: open as never, init: async () => { inits++; } });
    expect(inits).toBe(0); expect(ch2.err.join("")).toMatch(/repository not found/);
  });

  it("kills git when the channel closes early or the time cap is hit", async () => {
    let killed = 0;
    const open = async (_d: string, _t: unknown, h: Handlers) => ({
      execId: "e", onDrain: null, windowBytes: 1, write: () => true, inFlight: () => 0, ack() {}, end() {},
      kill() { killed++; setTimeout(() => h.onExit({ code: null, signal: "SIGKILL" }), 2); }, finished: false,
    });
    const ch = fakeChannel();
    const p = relayGitExec({ driveId: "d1", driveSecret: "s", repo: "r", service: "upload-pack", channel: ch, open: open as never });
    await new Promise((r) => setTimeout(r, 5));
    ch.emit("close");
    expect((await p).exit).toBe(1); expect(killed).toBe(1);

    const slow = fakeChannel();
    const out = await relayGitExec({ driveId: "d1", driveSecret: "s", repo: "r", service: "upload-pack", channel: slow, timeoutMs: 10, open: open as never });
    expect(out.exit).toBe(1); expect(slow.err.join("")).toMatch(/exceeded/);
  });
});

// ── process entry env parsing ───────────────────────────────────────────────
describe("ssh-server entry", () => {
  it("reads the port (default 2222, 0/off disables) and the host key path", async () => {
    const m = await import("../../ssh-server");
    expect(m.sshPortFromEnv({})).toBe(2222);
    expect(m.sshPortFromEnv({ AINDRIVE_SSH_PORT: "0" })).toBeNull();
    expect(m.sshPortFromEnv({ AINDRIVE_SSH_PORT: "off" })).toBeNull();
    expect(m.sshPortFromEnv({ AINDRIVE_SSH_PORT: "2022" })).toBe(2022);
    expect(m.sshPortFromEnv({ AINDRIVE_SSH_PORT: "99999" })).toBeNull();
    expect(m.defaultHostKeyPath({ AINDRIVE_DATA_DIR: "/data" })).toBe("/data/ssh_host_ed25519_key");
    expect(m.defaultHostKeyPath({ AINDRIVE_SSH_HOST_KEY_PATH: "/k" })).toBe("/k");
  });
});
