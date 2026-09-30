// R-DLG-READ-001 (docs/PERMISSIONS_MATRIX.md §1): origin-side enforcement of
// resource-scoped delegations (`ain-rdlg+jwt`, AIN SSO wallet-and-delegation
// §5) on fs/read and fs/list — plan task 05 criterion G1: the allowed agent
// reads the one file; another agent, organization or an expired token does not.
//
// A tiny AIN SSO runs on a local http server (JWKS + delegation status), so
// the real key fetch and status client are exercised; the drive's agent is a
// mock (online/offline per drive).
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { calculateJwkThumbprint, CompactSign, exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from "jose";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-rdlg-"));
process.env.AINDRIVE_PUBLIC_URL = "https://drive.test";
process.env.AINDRIVE_SESSION_SECRET = "rdlg-test-secret-0123456789abcdef0123456789";
process.env.AINDRIVE_SSO_CLIENT_ID = "app_aindrive";

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => { cookieJar.set(name, value); },
    delete: (name: string) => { cookieJar.delete(name); },
  }),
}));

// The drive agent: an in-memory file tree per drive, online or not.
const online = new Set<string>(["d1"]);
const files: Record<string, string> = {
  "d1:docs/report.md": "hello report",
  "d1:docs/other.md": "other",
  "d1:docs/sub/deep.md": "deep",
  "d1:premium/paid.md": "paid content",
  "d1:top.md": "top level",
  "d2:docs/report.md": "offline drive",
};
vi.mock("../rpc", () => {
  class AgentError extends Error {
    status: number;
    constructor(msg: string, status = 502) { super(msg); this.status = status; }
  }
  return {
    AgentError,
    isOnline: (driveId: string) => online.has(driveId),
    callAgent: async (driveId: string, _secret: string, params: { method: string; path: string }) => {
      if (!online.has(driveId)) throw new AgentError("agent offline", 504);
      if (params.method === "read") {
        const content = files[`${driveId}:${params.path}`];
        if (content === undefined) throw new AgentError("not found", 404);
        // What a real agent relays for a file removed under it: errno text naming the owner's disk.
        if (content === "__ENOENT__") throw new AgentError(`ENOENT: no such file or directory, open '/home/owner/Private Clients/${params.path}'`, 502);
        return { content };
      }
      if (params.method === "list") {
        const prefix = params.path ? `${params.path}/` : "";
        const names = new Set<string>();
        for (const k of Object.keys(files)) {
          const [d, p] = k.split(":");
          if (d === driveId && p.startsWith(prefix)) names.add(p.slice(prefix.length).split("/")[0]);
        }
        return { entries: [...names].map((name) => ({ name, type: name.includes(".") ? "file" : "dir" })) };
      }
      throw new AgentError("unsupported", 400);
    },
  };
});

const { db } = await import("../db.js");
const { sign } = await import("../session.js");
const rd = await import("../resource-delegation");
const { resolveAgentAuth } = await import("../agent-auth");
const readRoute = await import("../../app/api/drives/[driveId]/fs/read/route.js");
const listRoute = await import("../../app/api/drives/[driveId]/fs/list/route.js");
const deleteRoute = await import("../../app/api/drives/[driveId]/fs/delete/route.js");
const { setRouteLogSink } = await import("../request-id");

const ORIGIN = "https://drive.test";
const SUB_A = "acc_alice000001"; // linked to alice1 (viewer at d1/docs, viewer at d1/premium)
const SUB_B = "acc_bob0000001"; // linked to bob1 (no grants; suspended in its org)
const SUB_X = "acc_nobody00001"; // not linked to any account
const AGENT = "https://ainize.ai#gallery-guide";
const nowS = () => Math.floor(Date.now() / 1000);

// ── A tiny AIN SSO: signing key, JWKS and the status endpoint ────────────────
let server: Server;
let ISSUER = "";
const sso = await generateKeyPair("ES256");
const otherSso = await generateKeyPair("ES256"); // a key the JWKS does not publish
const ssoJwk = { ...(await exportJWK(sso.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
const revoked = new Set<string>();
const unknownJti = new Set<string>();
let statusMode: "ok" | "fail" = "ok";
let statusCalls = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/oidc/jwks") return send(200, { keys: [ssoJwk] });
    const m = /^\/api\/delegations\/([^/]+)\/status$/.exec(url.pathname);
    if (m) {
      statusCalls++;
      const jti = decodeURIComponent(m[1]);
      if (statusMode === "fail") return send(500, { error: "boom" });
      if (unknownJti.has(jti)) return send(404, { error: "not_found" });
      return send(200, { jti, revoked: revoked.has(jti), checkedAt: new Date().toISOString() });
    }
    send(404, { error: "not_found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  ISSUER = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  process.env.AINDRIVE_SSO_ISSUER = ISSUER;

  const u = db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)");
  for (const [id, email] of [["owner1", "o@example.com"], ["alice1", "a@example.com"], ["bob1", "b@example.com"]]) u.run(id, email, id, "x");
  const d = db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret, last_seen_at, created_at) VALUES (?,?,?,?,?,?,?)");
  d.run("d1", "owner1", "Team Drive", "h", "s", "2026-09-28 10:00:00", "2026-09-01 00:00:00");
  d.run("d2", "owner1", "Offline Drive", "h", "s", null, "2026-09-02 00:00:00");
  const m = db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role, created_at) VALUES (?,?,?,?,?,?)");
  m.run("m1", "d1", "alice1", "docs", "viewer", "2026-09-10 00:00:00");
  m.run("m2", "d1", "alice1", "premium", "viewer", "2026-09-11 00:00:00"); // priced, not bought
  m.run("m3", "d2", "alice1", "", "viewer", "2026-09-12 00:00:00");
  db.prepare("INSERT INTO shares (id, drive_id, path, role, token, price_usdc, currency, listed) VALUES (?,?,?,?,?,?,?,?)")
    .run("s_paid", "d1", "premium", "viewer", "tok_paid", 5, "USDC", 1);
  const t = Date.now();
  const ident = db.prepare("INSERT INTO sso_identities (issuer, subject, user_id, link_method, link_proof, linked_at, last_login_at) VALUES (?,?,?,?,?,?,?)");
  ident.run(ISSUER, SUB_A, "alice1", "jit", null, t, t);
  ident.run(ISSUER, SUB_B, "bob1", "provisioned", null, t, null);
  db.prepare(
    `INSERT INTO sso_memberships (issuer, org_id, subject, user_id, org_slug, org_name, status, app_role, groups_json, applied_version, legacy_user_id, ownership_transfer_to, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(ISSUER, "org_x", SUB_B, "bob1", "x", "X", "suspended", null, "[]", 1, null, null, t);
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

// ── Agents: the keys the grants are bound to ─────────────────────────────────
type Agent = { priv: KeyLike; jwk: JWK; jkt: string; alg: "ES256" | "EdDSA" };
async function agent(alg: "ES256" | "EdDSA"): Promise<Agent> {
  const kp = await generateKeyPair(alg);
  const jwk = await exportJWK(kp.publicKey);
  return { priv: kp.privateKey, jwk, jkt: await calculateJwkThumbprint(jwk, "sha256"), alg };
}
const agentA = await agent("ES256");
const agentB = await agent("ES256");
const agentC = await agent("EdDSA");

const fileKey = (driveId: string, path: string) => rd.resourceKey(ORIGIN, driveId, path);
const REPORT = fileKey("d1", "docs/report.md");

type Claims = Record<string, unknown>;
/** A delegation as AIN SSO would mint it (defaults: alice, agent A, read docs/report.md). */
async function rdlg(over: Claims = {}, o: { key?: KeyLike; typ?: string; alg?: string } = {}): Promise<string> {
  const iat = (over.iat as number | undefined) ?? nowS();
  const exp = (over.exp as number | undefined) ?? iat + 3600;
  const claims: Claims = {
    iss: ISSUER,
    sub: SUB_A,
    aud: [ORIGIN],
    org: null,
    agt: AGENT,
    res: [{ resource: REPORT, actions: ["read"] }],
    prd: "ainteams",
    cnf: { jkt: agentA.jkt },
    jti: `rdlg_${randomUUID().replace(/-/g, "")}`,
    ...over,
  };
  delete claims.iat;
  delete claims.exp;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: o.alg ?? "ES256", kid: "k1", typ: o.typ ?? "ain-rdlg+jwt" })
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(o.key ?? sso.privateKey);
}

/** The proof of possession an agent attaches to one request. */
async function pop(a: Agent, o: { method?: string; url: string; iat?: number; jti?: string; typ?: string; jwk?: JWK | null }): Promise<string> {
  const payload = { htm: o.method ?? "GET", htu: o.url, iat: o.iat ?? nowS(), jti: o.jti ?? randomUUID() };
  const header: Record<string, unknown> = { alg: a.alg, typ: o.typ ?? "ain-pop+jwt" };
  if (o.jwk !== null) header.jwk = o.jwk ?? a.jwk;
  return new CompactSign(new TextEncoder().encode(JSON.stringify(payload))).setProtectedHeader(header as never).sign(a.priv);
}

const ctx = (driveId: string) => ({ params: Promise.resolve({ driveId }) });
const responses: { status: number; text: string }[] = [];
async function capture(p: Promise<Response>): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await p;
  const text = await res.text();
  responses.push({ status: res.status, text });
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

type CallOpts = { token?: string | null; pop?: string | null; agent?: Agent; cookie?: string; requestId?: string };
async function call(kind: "read" | "list", driveId: string, path: string, o: CallOpts = {}) {
  const url = `${ORIGIN}/api/drives/${driveId}/fs/${kind}?path=${encodeURIComponent(path)}`;
  const headers: Record<string, string> = {};
  if (o.requestId) headers["x-request-id"] = o.requestId;
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  const proof = o.pop === null ? null : o.pop ?? (o.token ? await pop(o.agent ?? agentA, { url }) : null);
  if (proof) headers["x-ain-pop"] = proof;
  if (o.cookie) cookieJar.set("aindrive_session", o.cookie);
  else cookieJar.clear();
  const req = new Request(url, { headers });
  return capture(kind === "read" ? readRoute.GET(req, ctx(driveId)) : listRoute.GET(req, ctx(driveId)));
}

const logs: unknown[][] = [];
const spies = (["log", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a); }));
const minted: string[] = [];
const mint = async (...a: Parameters<typeof rdlg>) => { const t = await rdlg(...a); minted.push(t); return t; };

afterEach(() => {
  statusMode = "ok";
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("R-DLG-READ-001: the allowed agent reads the granted file", () => {
  it("reads the file the grant names (200, contract-free body as for any read)", async () => {
    const r = await call("read", "d1", "docs/report.md", { token: await mint() });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ content: "hello report", encoding: "utf8" });
  });

  it("reads a file under a granted FOLDER key, and lists it (list action)", async () => {
    const folder = fileKey("d1", "docs");
    const token = await mint({ res: [{ resource: folder, actions: ["read", "list"] }] });
    const r = await call("read", "d1", "docs/sub/deep.md", { token });
    expect(r.status).toBe(200);
    expect(r.body.content).toBe("deep");
    const l = await call("list", "d1", "docs", { token });
    expect(l.status).toBe(200);
    expect(l.body.entries.map((e: { name: string }) => e.name).sort()).toEqual(["other.md", "report.md", "sub"]);
    expect(l.body.role).toBe("viewer");
    // The drive root key (what scope=mine lists) covers the whole drive — for an account that may read there.
    const root = await mint({ sub: SUB_A, res: [{ resource: fileKey("d1", ""), actions: ["read"] }] });
    expect((await call("read", "d1", "docs/other.md", { token: root })).status).toBe(200);
    // …but the root is not the folder alice may read: top.md is outside her grant → user_forbidden.
    const top = await call("read", "d1", "top.md", { token: root });
    expect(top.status).toBe(403);
    expect(top.body.error.detail).toBe("user_forbidden");
  });

  it("a grant with `list` only does not read, and `read` only does not list", async () => {
    const folder = fileKey("d1", "docs");
    const listOnly = await mint({ res: [{ resource: folder, actions: ["list"] }] });
    const r = await call("read", "d1", "docs/report.md", { token: listOnly });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatchObject({ code: "forbidden", retryable: false, detail: "not_granted" });
    const readOnly = await mint({ res: [{ resource: folder, actions: ["read"] }] });
    expect((await call("list", "d1", "docs", { token: readOnly })).body.error.detail).toBe("not_granted");
  });

  it("the cookie session keeps working on the same route (no regression)", async () => {
    const r = await call("read", "d1", "docs/report.md", { cookie: await sign("alice1") });
    expect(r.status).toBe(200);
  });
});

describe("R-DLG-READ-001: who may not", () => {
  it("another agent cannot use the token: the proof must come from the key in cnf (agt is informational)", async () => {
    // Agent B proves with its own key against a grant bound to agent A's key → not proven.
    const token = await mint();
    const r = await call("read", "d1", "docs/report.md", { token, agent: agentB });
    expect(r.status).toBe(401);
    expect(r.body.error).toMatchObject({ code: "auth_required", detail: "pop_invalid" });
    // A grant AIN SSO issued to another agent NAME but bound to B's key works for B: the origin
    // binds the caller to the key, not to the `agt` string.
    const forB = await mint({ agt: "https://ainize.ai#some-other-agent", cnf: { jkt: agentB.jkt } });
    expect((await call("read", "d1", "docs/report.md", { token: forB, agent: agentB })).status).toBe(200);
  });

  it("a token for a different audience is refused (auth_required)", async () => {
    const r = await call("read", "d1", "docs/report.md", { token: await mint({ aud: ["https://other.test"] }) });
    expect(r.status).toBe(401);
    expect(r.body.error).toMatchObject({ code: "auth_required", detail: "wrong_audience", retryable: false });
    expect(r.headers.get("www-authenticate")).toContain("invalid_token");
  });

  it("a resource the grant does not name is forbidden (sibling, child-does-not-cover-parent, other drive)", async () => {
    const token = await mint();
    const sib = await call("read", "d1", "docs/other.md", { token });
    expect(sib.status).toBe(403);
    expect(sib.body.error.detail).toBe("not_granted");
    const child = await mint({ res: [{ resource: fileKey("d1", "docs/sub"), actions: ["read"] }] });
    expect((await call("read", "d1", "docs/report.md", { token: child })).body.error.detail).toBe("not_granted");
    // The same path on another drive has another key.
    const r2 = await call("read", "d2", "docs/report.md", { token });
    expect(r2.body.error.detail).toBe("not_granted");
  });

  it("no wildcard: a `*` in res is an invalid claim; ttl over an hour too", async () => {
    const star = await call("read", "d1", "docs/report.md", { token: await mint({ res: [{ resource: `${ORIGIN}#d1#*`, actions: ["read"] }] }) });
    expect(star.status).toBe(401);
    expect(star.body.error.detail).toBe("invalid_claims");
    const iat = nowS();
    const long = await call("read", "d1", "docs/report.md", { token: await mint({ iat, exp: iat + 3601 }) });
    expect(long.body.error.detail).toBe("invalid_claims");
  });

  it("write is never delegated: a `write` grant is refused by the decision and by the write routes", async () => {
    const token = await mint({ res: [{ resource: REPORT, actions: ["read", "write"] }] });
    // The read still works…
    expect((await call("read", "d1", "docs/report.md", { token })).status).toBe(200);
    // …the decision refuses the write action even though it is granted…
    const claims = await rd.verifyResourceDelegation(token);
    const d = rd.mayReadWithDelegation({ claims, driveId: "d1", path: "docs/report.md", action: "write" });
    expect(d).toMatchObject({ ok: false, code: "forbidden", reason: "action_not_supported" });
    // …and a write route does not take the token at all (no cookie → 401 as for anyone).
    const url = `${ORIGIN}/api/drives/d1/fs/delete`;
    const req = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-ain-pop": await pop(agentA, { method: "POST", url }) },
      body: JSON.stringify({ path: "docs/report.md" }),
    });
    cookieJar.clear();
    const res = await capture(deleteRoute.POST(req, ctx("d1")));
    expect(res.status).toBe(401);
    expect(files["d1:docs/report.md"]).toBe("hello report");
  });

  it("expired → auth_required; not yet valid → auth_required", async () => {
    const past = nowS() - 7200;
    const r = await call("read", "d1", "docs/report.md", { token: await mint({ iat: past, exp: past + 3600 }) });
    expect(r.status).toBe(401);
    expect(r.body.error).toMatchObject({ code: "auth_required", detail: "expired" });
    const future = nowS() + 600;
    const f = await call("read", "d1", "docs/report.md", { token: await mint({ iat: future, exp: future + 600 }) });
    expect(f.body.error.detail).toBe("expired");
  });

  it("revoked at the issuer → forbidden; an unknown jti (404) reads as revoked", async () => {
    const token = await mint();
    const claims = await rd.verifyResourceDelegation(token);
    revoked.add(claims.jti);
    const r = await call("read", "d1", "docs/report.md", { token });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatchObject({ code: "forbidden", detail: "revoked" });
    const gone = await mint();
    unknownJti.add((await rd.verifyResourceDelegation(gone)).jti);
    expect((await call("read", "d1", "docs/report.md", { token: gone })).body.error.detail).toBe("revoked");
  });

  it("a sub with no linked account → forbidden", async () => {
    const r = await call("read", "d1", "docs/report.md", { token: await mint({ sub: SUB_X }) });
    expect(r.status).toBe(403);
    expect(r.body.error.detail).toBe("sub_not_linked");
  });

  it("the three-check rule: the linked account must be able to read right now", async () => {
    // bob is linked but has no grant on d1 → user_forbidden; also his membership is suspended.
    const bob = await call("read", "d1", "docs/report.md", { token: await mint({ sub: SUB_B }) });
    expect(bob.status).toBe(403);
    expect(bob.body.error.detail).toBe("user_forbidden");
    // alice's viewer grant at a priced path she has not bought → the delegation cannot read it either.
    const paid = await call("read", "d1", "premium/paid.md", { token: await mint({ res: [{ resource: fileKey("d1", "premium/paid.md"), actions: ["read"] }] }) });
    expect(paid.status).toBe(403);
    expect(paid.body.error.detail).toBe("user_forbidden");
    // alice loses her membership while the token is still valid → forbidden from then on.
    const token = await mint();
    expect((await call("read", "d1", "docs/report.md", { token })).status).toBe(200);
    db.prepare("DELETE FROM drive_members WHERE id = 'm1'").run();
    try {
      const lost = await call("read", "d1", "docs/report.md", { token });
      expect(lost.status).toBe(403);
      expect(lost.body.error.detail).toBe("user_forbidden");
    } finally {
      db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role, created_at) VALUES ('m1','d1','alice1','docs','viewer','2026-09-10 00:00:00')").run();
    }
  });

  it("the reserved .aindrive/ subtree is never readable, whatever the grant says", async () => {
    const token = await mint({ sub: SUB_A, res: [{ resource: fileKey("d1", ""), actions: ["read"] }] });
    const r = await call("read", "d1", ".aindrive/agent-token", { token });
    expect(r.status).toBe(403);
    expect(r.body.error.detail).toBe("reserved_path");
  });

  it("a token signed by a key the issuer does not publish, or of another type, is refused", async () => {
    const forged = await call("read", "d1", "docs/report.md", { token: await mint({}, { key: otherSso.privateKey }) });
    expect(forged.status).toBe(401);
    expect(forged.body.error.detail).toBe("invalid_token");
    // An adapter/ID token with the same signing key must not pass as a delegation: it is not
    // even routed here (no typ) — the route falls back to the cookie → 401 "forbidden".
    const idLike = await call("read", "d1", "docs/report.md", { token: await mint({}, { typ: "JWT" }), pop: null });
    expect(idLike.status).toBe(401);
    expect(idLike.body).toEqual({ error: "forbidden" });
  });
});

describe("R-DLG-READ-001: proof of possession (X-AIN-PoP)", () => {
  const url = `${ORIGIN}/api/drives/d1/fs/read?path=docs%2Freport.md`;

  it("missing → auth_required pop_required; wrong URL, method, typ, stale iat, no jwk → pop_invalid", async () => {
    const token = await mint();
    const missing = await call("read", "d1", "docs/report.md", { token, pop: null });
    expect(missing.status).toBe(401);
    expect(missing.body.error.detail).toBe("pop_required");
    const cases: Record<string, string> = {
      url: await pop(agentA, { url: `${ORIGIN}/api/drives/d1/fs/list` }),
      method: await pop(agentA, { url, method: "POST" }),
      typ: await pop(agentA, { url, typ: "JWT" }),
      stale: await pop(agentA, { url, iat: nowS() - 120 }),
      nojwk: await pop(agentA, { url, jwk: null }),
      otherKeyInHeader: await pop(agentA, { url, jwk: agentB.jwk }),
      garbage: "not.a.jws",
    };
    for (const [name, proof] of Object.entries(cases)) {
      const r = await call("read", "d1", "docs/report.md", { token, pop: proof });
      expect(r.status, name).toBe(401);
      expect(r.body.error.detail, name).toBe("pop_invalid");
    }
    // The query string is not part of htu: a proof over the path alone is fine.
    const noQuery = await pop(agentA, { url: `${ORIGIN}/api/drives/d1/fs/read` });
    expect((await call("read", "d1", "docs/report.md", { token, pop: noQuery })).status).toBe(200);
  });

  it("a replayed proof (same jti) is refused the second time", async () => {
    const token = await mint();
    const proof = await pop(agentA, { url });
    expect((await call("read", "d1", "docs/report.md", { token, pop: proof })).status).toBe(200);
    const again = await call("read", "d1", "docs/report.md", { token, pop: proof });
    expect(again.status).toBe(401);
    expect(again.body.error.detail).toBe("pop_replayed");
  });

  it("cnf.jwk binds the key directly (Ed25519); another key's proof is refused", async () => {
    const token = await mint({ cnf: { jwk: agentC.jwk } });
    expect((await call("read", "d1", "docs/report.md", { token, agent: agentC })).status).toBe(200);
    // Header jwk may be omitted with cnf.jwk.
    expect((await call("read", "d1", "docs/report.md", { token, pop: await pop(agentC, { url, jwk: null }) })).status).toBe(200);
    const r = await call("read", "d1", "docs/report.md", { token, agent: agentA });
    expect(r.body.error.detail).toBe("pop_invalid");
    // A cnf.jwk carrying a private member is never used.
    const leaky = await mint({ cnf: { jwk: { ...agentC.jwk, d: "AAAA" } } });
    expect((await call("read", "d1", "docs/report.md", { token: leaky, agent: agentC })).body.error.detail).toBe("pop_invalid");
  });
});

describe("R-DLG-READ-001: source and issuer availability", () => {
  it("drive offline → source_offline (503, retryable)", async () => {
    const token = await mint({ res: [{ resource: fileKey("d2", "docs/report.md"), actions: ["read"] }] });
    const r = await call("read", "d2", "docs/report.md", { token });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatchObject({ code: "source_offline", retryable: true });
    online.add("d2");
    try { expect((await call("read", "d2", "docs/report.md", { token })).status).toBe(200); } finally { online.delete("d2"); }
  });

  it("status endpoint down with nothing cached → temporary_failure; a cached answer is reused (stale) while it is down", async () => {
    statusMode = "fail";
    const fresh = await mint();
    const r = await call("read", "d1", "docs/report.md", { token: fresh });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatchObject({ code: "temporary_failure", retryable: true, detail: "status_unavailable" });
    statusMode = "ok";
    expect((await call("read", "d1", "docs/report.md", { token: fresh })).status).toBe(200);
    statusMode = "fail";
    // Cached (< 60 s): no fetch, still allowed.
    const before = statusCalls;
    expect((await call("read", "d1", "docs/report.md", { token: fresh })).status).toBe(200);
    expect(statusCalls).toBe(before);
  });

  it("status client: caches 60 s, keeps a stale answer on failure, fails closed with none", async () => {
    let t = 1_000_000;
    let mode: "ok" | "revoked" | "fail" = "ok";
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (mode === "fail") return new Response("boom", { status: 500 });
      return Response.json({ jti: "rdlg_1", revoked: mode === "revoked", checkedAt: new Date(t).toISOString() });
    }) as typeof fetch;
    const client = rd.createDelegationStatusClient({ issuer: ISSUER, fetch: fetchImpl, now: () => new Date(t) });
    expect((await client.check("rdlg_1")).revoked).toBe(false);
    t += 59_000;
    expect((await client.check("rdlg_1")).revoked).toBe(false);
    expect(calls).toBe(1);
    t += 2_000;
    mode = "revoked";
    expect((await client.check("rdlg_1")).revoked).toBe(true);
    expect(calls).toBe(2);
    t += 61_000;
    mode = "fail";
    expect((await client.check("rdlg_1")).revoked).toBe(true); // stale, but a revocation seen once stays seen
    await expect(client.check("rdlg_2")).rejects.toBeInstanceOf(rd.DelegationStatusUnavailable);
    client.forget("rdlg_1");
    await expect(client.check("rdlg_1")).rejects.toBeInstanceOf(rd.DelegationStatusUnavailable);
  });
});

describe("06.5: a delegated listing follows the same rule as the account's own", () => {
  it("names hidden from the account (unlisted sale, reserved subtree) are hidden from its agent too", async () => {
    // d3: alice is a root viewer; an unlisted sale and a stray `.aindrive` entry sit at the root.
    db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret, last_seen_at, created_at) VALUES (?,?,?,?,?,?,?)")
      .run("d3", "owner1", "Root Share", "h", "s", "2026-09-28 10:00:00", "2026-09-03 00:00:00");
    db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role, created_at) VALUES (?,?,?,?,?,?)")
      .run("m_d3", "d3", "alice1", "", "viewer", "2026-09-12 00:00:00");
    const s = db.prepare("INSERT INTO shares (id, drive_id, path, role, token, price_usdc, currency, listed) VALUES (?,?,?,?,?,?,?,?)");
    s.run("s_d3_private", "d3", "private-sale", "viewer", "tok_d3p", 9, "USDC", 0);
    s.run("s_d3_listed", "d3", "listed-sale", "viewer", "tok_d3l", 9, "USDC", 1);
    Object.assign(files, {
      "d3:open.md": "open",
      "d3:private-sale/secret.md": "secret",
      "d3:listed-sale/teaser.md": "teaser",
      "d3:.aindrive/config.json": "{}",
    });
    online.add("d3");
    try {
      const token = await mint({ res: [{ resource: fileKey("d3", ""), actions: ["list", "read"] }] });
      const delegated = await call("list", "d3", "", { token });
      const own = await call("list", "d3", "", { cookie: await sign("alice1") });
      expect(delegated.status).toBe(200);
      const names = (b: { entries: { name: string; locked?: boolean }[] }) => b.entries.map((e) => `${e.name}${e.locked ? ":locked" : ""}`).sort();
      expect(names(delegated.body)).toEqual(["listed-sale:locked", "open.md"]);
      expect(names(delegated.body)).toEqual(names(own.body));
      // …and the bytes behind a hidden or locked name stay closed to the agent.
      for (const p of ["private-sale/secret.md", "listed-sale/teaser.md", ".aindrive/config.json"]) {
        const r = await call("read", "d3", p, { token: await mint({ res: [{ resource: fileKey("d3", ""), actions: ["read"] }] }) });
        expect(r.status, p).toBe(403);
      }
    } finally {
      online.delete("d3");
    }
  });

  it("an agent error never relays the device's text (absolute paths, other names): a fixed message per code", async () => {
    files["d1:docs/gone.md"] = "__ENOENT__";
    try {
      const token = await mint({ res: [{ resource: fileKey("d1", "docs"), actions: ["read"] }] });
      const r = await call("read", "d1", "docs/gone.md", { token });
      expect(r.status).toBe(410);
      expect(r.body.error).toMatchObject({ code: "resource_deleted", retryable: false, message: "the file is no longer there" });
      const text = JSON.stringify(r.body);
      expect(text).not.toContain("/home/owner");
      expect(text).not.toContain("Private Clients");
      // The cookie caller (the account itself) keeps the old body.
      const own = await call("read", "d1", "docs/gone.md", { cookie: await sign("alice1") });
      expect(own.status).toBe(502);
    } finally {
      delete files["d1:docs/gone.md"];
    }
  });
});

describe("12.5: request ids and log lines on the delegated routes", () => {
  const lines: Record<string, unknown>[] = [];
  beforeAll(() => setRouteLogSink((l) => { lines.push(l); }));
  afterAll(() => setRouteLogSink(null));
  afterEach(() => { delete process.env.AIN_INTEGRATION_ENABLED; lines.length = 0; });

  it("flag on: every answer carries X-Request-Id (the caller's own when well-formed) and one log line with ids, no token", async () => {
    process.env.AIN_INTEGRATION_ENABLED = "1";
    const token = await mint();
    const ok = await call("read", "d1", "docs/report.md", { token, requestId: "trace-0001-abcdef" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-request-id")).toBe("trace-0001-abcdef");
    const claims = await rd.verifyResourceDelegation(token);
    expect(lines).toEqual([{
      requestId: "trace-0001-abcdef", route: "fs/read", status: 200, driveId: "d1", auth: "delegation",
      userId: "alice1", taskId: claims.jti, resourceId: REPORT,
    }]);
    // A refusal is logged with its contract code and detail; a malformed (or token-shaped) inbound id is replaced.
    const denied = await call("list", "d1", "docs", { token, requestId: token.slice(0, 100) });
    expect(denied.status).toBe(403);
    const rid = denied.headers.get("x-request-id")!;
    expect(rid).toMatch(/^req_[0-9a-f]{24}$/);
    expect(lines[1]).toMatchObject({ requestId: rid, route: "fs/list", status: 403, code: "forbidden", detail: "not_granted", auth: "delegation" });
    for (const l of lines) {
      const text = JSON.stringify(l);
      expect(text).not.toContain(token);
      expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
      expect(text).not.toContain("docs/report.md"); // the resource is its id, never its path
    }
  });

  it("flag off: no header and no line (the route answers as before)", async () => {
    const r = await call("read", "d1", "docs/report.md", { token: await mint() });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-request-id")).toBeNull();
    expect(lines).toEqual([]);
  });
});

describe("R-DLG-READ-001: other surfaces and hygiene", () => {
  it("the agent protocols (A2A/AG-UI) refuse a delegation token by name", async () => {
    const token = await mint();
    const auth = await resolveAgentAuth(new Request(`${ORIGIN}/a2a`, { headers: { authorization: `Bearer ${token}` } }));
    expect(auth.ok).toBe(false);
    if (!auth.ok) {
      expect(auth.status).toBe(403);
      expect(auth.error).toMatch(/fs\/read/);
    }
  });

  it("resource keys: the file's key first, then every ancestor up to the drive root; spelling is canonical", () => {
    const keys = rd.coveringResourceKeys(ORIGIN, "d1", "docs/sub/deep.md");
    expect(keys).toEqual([fileKey("d1", "/docs/sub/deep.md"), fileKey("d1", "docs/sub"), fileKey("d1", "docs"), fileKey("d1", "")]);
    expect(rd.coveringResourceKeys(ORIGIN, "d1", "./docs//sub/deep.md")).toEqual(keys);
    expect(rd.coveringResourceKeys(ORIGIN, "d1", "")).toEqual([fileKey("d1", "/")]);
    expect(keys.every((k) => !k.includes("*"))).toBe(true);
  });

  it("no token appears in any response body or log line", () => {
    expect(minted.length).toBeGreaterThan(10);
    expect(responses.length).toBeGreaterThan(20);
    for (const token of minted) {
      for (const r of responses) expect(r.text).not.toContain(token);
      for (const line of logs) expect(JSON.stringify(line)).not.toContain(token);
    }
    // No PoP either: bodies never echo request headers.
    for (const r of responses) expect(r.text).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\.eyJ/);
    spies.forEach((s) => s.mockRestore());
  });
});
