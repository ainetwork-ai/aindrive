// "ainize.json이 있다는 건 자동 배포가 되었다는 것": a push through the real gitHttpPOST of a repo
// whose root has ainize.json, bound to no project, makes aindrive (as itself, with an AIN SSO
// machine token from a fake token endpoint) create the project at a fake ainize
// (POST /api/projects/auto), store the one-time secret, and fire the signed hook for that push.
// A bound repo just hooks; no manifest / no org URL / no credentials / a refusal bind nothing
// and never fail the push.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-autobind-"));
process.env.AINDRIVE_SESSION_SECRET = "auto-bind-test-secret-0123456789abcdef";
process.env.AINDRIVE_PUBLIC_URL = "https://drive.example.test";
process.env.AINIZE_URL = "https://ainize.example.test";
const ISSUER = "https://sso.example.test";
process.env.AINDRIVE_SSO_ISSUER = ISSUER;
process.env.AINDRIVE_SSO_CLIENT_ID = "aindrive";
process.env.AINDRIVE_SSO_CLIENT_SECRET = "aindrive-secret";

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({
    get: (name: string) => { const v = cookieJar.get(name); return v === undefined ? undefined : { name, value: v }; },
    set: (name: string, value: string) => { cookieJar.set(name, value); },
    delete: (name: string) => { cookieJar.delete(name); },
  }),
}));

type Call = Record<string, unknown>;
const agent = { files: {} as Record<string, string> };
vi.mock("../rpc", () => ({
  AgentError: class extends Error { status: number; constructor(m: string, s = 502) { super(m); this.status = s; } },
  isOnline: () => true,
  callAgent: async (_d: string, _s: string, req: Call) => {
    switch (req.method) {
      case "git-advertise": return { method: "git-advertise", exists: true, data: "" };
      case "upload-chunk": return { method: "upload-chunk", ok: true, receivedBytes: 1 };
      case "git-service": return { method: "git-service", ok: true, size: 4 };
      case "download-chunk": return { method: "download-chunk", data: Buffer.from("0000").toString("base64"), eof: true };
      case "delete": return { method: "delete", ok: true };
      case "read": {
        const c = agent.files[String(req.path)];
        if (c === undefined) throw new Error("ENOENT");
        return { method: "read", content: c, encoding: "utf8" };
      }
    }
    return { ok: true };
  },
}));

const { db } = await import("../db.js");
const { sign } = await import("../session.js");
const orgs = await import("../orgs.js");
const hooks = await import("../git-project-hooks");
const { resetServiceTokensForTests } = await import("../sso/service-token");
const { gitHttpPOST } = await import("../git-http");

const OLD = "0".repeat(40), NEW = "a".repeat(40);
function pushBody(ref = "refs/heads/main", after = NEW) {
  const cmd = `${OLD} ${after} ${ref}\0report-status\n`;
  const pkt = (Buffer.byteLength(cmd) + 4).toString(16).padStart(4, "0") + cmd;
  return Buffer.concat([Buffer.from(pkt), Buffer.from("0000"), Buffer.from("PACKfake")]);
}

/** The world outside: AIN SSO (discovery + token endpoint) and ainize (auto + hook). */
type Seen = { url: string; init: RequestInit; json: unknown };
const seen: Seen[] = [];
let autoAnswer: () => Response = () => new Response(JSON.stringify({ id: "prj_auto", pageUrl: "https://ainize.example.test/projects/prj_auto", webhookSecret: "whsec_from_ainize_once", created: true }), { status: 201 });
let tokenAnswer: () => Response = () => Response.json({ access_token: "svc_token_1", token_type: "Bearer", expires_in: 300 });
const world = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const body = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "";
  let json: unknown = null;
  try { json = body.startsWith("{") ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body)); } catch {}
  seen.push({ url, init: init ?? {}, json });
  if (url === `${ISSUER}/.well-known/openid-configuration`) return Response.json({ issuer: ISSUER, token_endpoint: `${ISSUER}/oidc/token`, jwks_uri: `${ISSUER}/oidc/jwks` });
  if (url === `${ISSUER}/oidc/token`) return tokenAnswer();
  if (url === "https://ainize.example.test/api/projects/auto") return autoAnswer();
  if (/\/api\/projects\/[^/]+\/hook$/.test(url)) return new Response(JSON.stringify({ deploymentId: "dep_1", status: "queued" }), { status: 202 });
  return new Response("not found", { status: 404 });
});

beforeAll(() => {
  const u = db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)");
  u.run("owner1", "o@example.com", "Owner", "x");
  u.run("ed1", "editor@example.com", "Ed Itor", "x");
  const d = db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)");
  d.run("d1", "owner1", "comcom", "h", "s");   // shared with comcom → /comcom/git/<repo>
  d.run("d2", "owner1", "Lone", "h", "s");     // no organization → only the drive-id URL
  const m = db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)");
  m.run("m1", "d1", "ed1", "", "editor");
  m.run("m2", "d2", "ed1", "", "editor");
  db.prepare(
    `INSERT INTO sso_memberships (issuer, org_id, subject, user_id, org_slug, org_name, status, app_role, groups_json, applied_version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'member', '[]', 1, ?)`,
  ).run(ISSUER, "org_comcom", "acc_owner", "owner1", "comcom", "ComCom", "active", Date.now());
  db.prepare("INSERT INTO sso_identities (issuer, subject, user_id, link_method, linked_at) VALUES (?,?,?,?,?)").run(ISSUER, "acc_ed", "ed1", "test", Date.now());
  orgs.shareDriveWithOrg({ driveId: "d1", issuer: ISSUER, orgId: "org_comcom", role: "editor", actor: "operator", via: "operator" });
});
beforeEach(() => {
  seen.length = 0; agent.files = {}; db.prepare("DELETE FROM git_project_hooks").run(); resetServiceTokensForTests();
  autoAnswer = () => new Response(JSON.stringify({ id: "prj_auto", pageUrl: "https://ainize.example.test/projects/prj_auto", webhookSecret: "whsec_from_ainize_once", created: true }), { status: 201 });
  tokenAnswer = () => Response.json({ access_token: "svc_token_1", token_type: "Bearer", expires_in: 300 });
  vi.stubGlobal("fetch", world);
});
afterEach(() => { vi.unstubAllGlobals(); });

async function push(driveId: string, repo = "repositories/proj", body = pushBody()) {
  const jwt = await sign("ed1");
  const req = new Request(`http://x/api/drives/${driveId}/git/${repo}/git-receive-pack`, {
    method: "POST", headers: { authorization: `Bearer ${jwt}`, "content-type": "application/x-git-receive-pack-request" },
    body, // @ts-expect-error duplex is required by undici for a streamed body
    duplex: "half",
  });
  const res = await gitHttpPOST(driveId, [repo, "git-receive-pack"], req);
  expect(res.status).toBe(200);
  await res.text();
  return res;
}
const calls = (re: RegExp) => seen.filter((s) => re.test(s.url));

describe("push of a repo with ainize.json", () => {
  it("binds the project as aindrive (machine token for the ainize origin) and fires the hook for that push", async () => {
    agent.files["repositories/proj/ainize.json"] = JSON.stringify({ kind: "script", entry: "art_search.py", name: "Clef search" });
    await push("d1");
    await vi.waitFor(() => expect(calls(/\/hook$/)).toHaveLength(1));

    const token = calls(/\/oidc\/token$/)[0]!;
    expect(token.init.headers).toMatchObject({ authorization: `Basic ${Buffer.from("aindrive:aindrive-secret").toString("base64")}` });
    expect(token.json).toEqual({ grant_type: "client_credentials", resource: "https://ainize.example.test" });

    const auto = calls(/\/api\/projects\/auto$/)[0]!;
    expect((auto.init.headers as Record<string, string>).authorization).toBe("Bearer svc_token_1");
    expect(auto.json).toEqual({
      repo: "https://drive.example.test/comcom/git/proj", branch: "main",
      pusher: { subject: "acc_ed", email: "editor@example.com" }, manifest: { kind: "script", name: "Clef search" },
    });
    expect(hooks.projectHookFor("d1", "repositories/proj")).toEqual({ projectId: "prj_auto", secret: "whsec_from_ainize_once" });
    expect(db.prepare("SELECT created_by FROM git_project_hooks WHERE drive_id='d1' AND repo='repositories/proj'").get()).toEqual({ created_by: "ed1" });

    const hook = calls(/\/hook$/)[0]!;
    expect(hook.url).toBe("https://ainize.example.test/api/projects/prj_auto/hook");
    expect(hook.json).toEqual({ ref: "refs/heads/main", before: OLD, after: NEW, pusher: { subject: "acc_ed", email: "editor@example.com" } });
    expect((hook.init.headers as Record<string, string>)["X-Ainize-Signature"]).toBe("sha256=" + createHmac("sha256", "whsec_from_ainize_once").update(hook.init.body as string).digest("hex"));
  });

  it("a bound repo only hooks: no token, no auto call; the cached token serves a later binding", async () => {
    agent.files["repositories/proj/ainize.json"] = JSON.stringify({ kind: "script" });
    hooks.storeProjectHook("d1", "repositories/proj", "prj_manual", "whsec_manual_______", "ed1");
    await push("d1");
    await vi.waitFor(() => expect(calls(/\/hook$/)).toHaveLength(1));
    expect(calls(/\/auto$|\/oidc\/token$/)).toHaveLength(0);
    expect(calls(/\/hook$/)[0]!.url).toContain("prj_manual");
    // another repo in the same drive: one token request serves it (the client caches per resource)
    agent.files["repositories/other/ainize.json"] = JSON.stringify({ kind: "nextjs" });
    await push("d1", "repositories/other");
    await vi.waitFor(() => expect(calls(/\/hook$/)).toHaveLength(2));
    expect(calls(/\/oidc\/token$/)).toHaveLength(1);
    await push("d1", "repositories/proj"); // bound in the first step
    await push("d1", "repositories/other"); // bound by the auto call above
    await vi.waitFor(() => expect(calls(/\/hook$/)).toHaveLength(4));
    expect(calls(/\/oidc\/token$/)).toHaveLength(1);
    expect(calls(/\/auto$/)).toHaveLength(1);
  });

  it("binds nothing without ainize.json, for a drive without an organization URL, for a branch deletion, or without credentials — and the push succeeds", async () => {
    await push("d1"); // no manifest
    agent.files["repositories/proj/ainize.json"] = JSON.stringify({ kind: "script" });
    await push("d2"); // /api/drives/d2/git/proj: no org
    await push("d1", "repositories/proj", pushBody("refs/heads/main", "0".repeat(40))); // deletion
    await push("d1", "repositories/proj", pushBody("refs/tags/v1")); // not a branch
    const secret = process.env.AINDRIVE_SSO_CLIENT_SECRET;
    delete process.env.AINDRIVE_SSO_CLIENT_SECRET;
    try { await push("d1"); } finally { process.env.AINDRIVE_SSO_CLIENT_SECRET = secret; }
    await new Promise((r) => setTimeout(r, 50));
    expect(calls(/\/auto$|\/hook$|\/oidc\/token$/)).toHaveLength(0);
    expect(hooks.projectIdFor("d1", "repositories/proj")).toBeNull();
    expect(hooks.projectIdFor("d2", "repositories/proj")).toBeNull();
  });

  it("an existing project without a secret here, a refusal, or a token the issuer will not mint: logged, nothing stored, push fine", async () => {
    agent.files["repositories/proj/ainize.json"] = JSON.stringify({ kind: "script" });
    autoAnswer = () => Response.json({ id: "prj_elsewhere", pageUrl: "x", created: false }, { status: 200 });
    await push("d1");
    await vi.waitFor(() => expect(calls(/\/auto$/)).toHaveLength(1));
    autoAnswer = () => new Response(JSON.stringify({ error: { code: "org_not_allowed", message: "no" } }), { status: 403 });
    await push("d1");
    await vi.waitFor(() => expect(calls(/\/auto$/)).toHaveLength(2));
    resetServiceTokensForTests();
    tokenAnswer = () => new Response(JSON.stringify({ error: "invalid_target" }), { status: 400 });
    await push("d1");
    await vi.waitFor(() => expect(calls(/\/oidc\/token$/)).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls(/\/hook$/)).toHaveLength(0);
    expect(hooks.projectIdFor("d1", "repositories/proj")).toBeNull();
  });

  it("autoBindProject reports why", async () => {
    const update = { ref: "refs/heads/main", before: OLD, after: NEW };
    expect(await hooks.autoBindProject("d1", "repositories/proj", update, "ed1", { driveSecret: "s" })).toEqual({ bound: false, reason: "no_manifest" });
    agent.files["repositories/proj/ainize.json"] = "{ not json";
    expect(await hooks.autoBindProject("d1", "repositories/proj", update, "ed1", { driveSecret: "s" })).toEqual({ bound: false, reason: "no_manifest" });
    agent.files["repositories/proj/ainize.json"] = JSON.stringify({ kind: "script" });
    expect(await hooks.autoBindProject("d2", "repositories/proj", update, "ed1", { driveSecret: "s" })).toEqual({ bound: false, reason: "no_org_url" });
    expect(await hooks.autoBindProject("d1", "repositories/proj", update, null, { driveSecret: "s" })).toEqual({ bound: true, projectId: "prj_auto", created: true });
    expect(calls(/\/auto$/)[0]!.json).toMatchObject({ pusher: { subject: null, email: null } });
  });
});
