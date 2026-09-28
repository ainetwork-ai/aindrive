// Provisioning adapter (ain-sso.adapter.v1): strict request verification,
// version monotonicity, legacy mapping rules, and what suspension /
// deprovisioning must do before answering 200 — end every session (cookie,
// bearer, pairing token, SSO session row, open collab sockets), revoke the
// organization's credentials, keep personal ones and all personal data, and
// block every sign-in path whatever AINDRIVE_LEGACY_LOGIN / SSO_ENABLED say.
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { SignJWT } from "jose";
import { CLIENT_ID, CLIENT_SECRET, cookieJar, createTestIssuer, ISSUER, PUBLIC_URL } from "./sso-test-issuer";
import type { DesiredUserState } from "../sso/store.js";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-sso-adapter-"));
process.env.AINDRIVE_PUBLIC_URL = PUBLIC_URL;
process.env.AINDRIVE_SESSION_SECRET = "sso-adapter-test-secret-0123456789abcdef";
process.env.AINDRIVE_SSO_ISSUER = ISSUER;
process.env.AINDRIVE_SSO_CLIENT_ID = CLIENT_ID;

const { jar, cookies } = cookieJar();
vi.mock("next/headers", () => ({ cookies }));

const { db } = await import("../db.js");
const session = await import("../session");
const store = await import("../sso/store.js");
const oidc = await import("../sso/oidc");
const { handleAdapterUser, handleAdapterHealth } = await import("../sso/adapter");
const mcpTokens = await import("../mcp-tokens");
const accountTokens = await import("../account-tokens");
const { onDocConnect } = await import("../dochub.js");
const userRoute = await import("../../app/api/sso/v1/orgs/[orgId]/users/[sub]/route.js");
const loginRoute = await import("../../app/api/auth/login/route.js");
const pollRoute = await import("../../app/api/auth/cli/poll/route.js");

const issuer = await createTestIssuer();
const ORG = { id: "org_comcom", slug: "comcom", name: "ComCom" };
const userUrl = (orgId: string, sub: string) => `${PUBLIC_URL}/api/sso/v1/orgs/${encodeURIComponent(orgId)}/users/${encodeURIComponent(sub)}`;

function desired(sub: string, over: Partial<DesiredUserState> = {}): DesiredUserState {
  return {
    schema: "ain-sso.adapter.v1",
    sub,
    org: ORG,
    version: 1,
    status: "active",
    profile: { name: "Kim Minji", email: `${sub}@personal.example`, workEmail: `${sub}@comcom.example` },
    appRole: "member",
    groups: [{ id: "grp_2", slug: "eng", name: "Eng", kind: "team" }, { id: "grp_1", slug: "all", name: "All", kind: "department" }],
    legacyUserId: null,
    ownershipTransferTo: null,
    issuedAt: new Date().toISOString(),
    ...over,
  };
}

type TokenOpts = Parameters<typeof issuer.adapterToken>[0];
async function put(s: DesiredUserState, o: { token?: Partial<TokenOpts>; body?: string; url?: string; auth?: string | null } = {}) {
  const body = JSON.stringify(s);
  const url = userUrl(s.org.id, s.sub);
  const token = await issuer.adapterToken({ method: "PUT", url, body, ...o.token });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (o.auth !== null) headers.authorization = o.auth ?? `Bearer ${token}`;
  const req = new Request(o.url ?? url, { method: "PUT", body: o.body ?? body, headers });
  return handleAdapterUser(req, s.org.id, s.sub, { keys: issuer.keys });
}
async function get(orgId: string, sub: string) {
  const url = userUrl(orgId, sub);
  const token = await issuer.adapterToken({ method: "GET", url });
  return handleAdapterUser(new Request(url, { headers: { authorization: `Bearer ${token}` } }), orgId, sub, { keys: issuer.keys });
}
const membershipCount = (sub: string) => (db.prepare("SELECT count(*) c FROM sso_memberships WHERE subject = ?").get(sub) as { c: number }).c;

type FakeWs = { closedWith: number | null; readyState: number; OPEN: number; close(code: number): void; send(): void; on(): void };
const fakeWs = (): FakeWs => ({ closedWith: null, readyState: 1, OPEN: 1, close(code) { this.closedWith = code; }, send() {}, on() {} });

beforeEach(() => {
  jar.clear();
  (globalThis as { __rl_buckets__?: Map<unknown, unknown> }).__rl_buckets__?.clear();
  for (const k of ["AINDRIVE_SSO_CLIENT_SECRET", "AINDRIVE_SSO_ENABLED", "AINDRIVE_LEGACY_LOGIN"]) delete process.env[k];
});

describe("health", () => {
  it("answers without auth", async () => {
    const res = handleAdapterHealth(new Request(`${PUBLIC_URL}/api/sso/v1/health`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", schema: "ain-sso.adapter.v1" });
  });
});

describe("request verification (adapter-protocol §3.2) — every failure is 401 without side effects", () => {
  const now = () => Math.floor(Date.now() / 1000);
  const cases: [string, (s: DesiredUserState) => Promise<Response>, string?][] = [
    ["no bearer token", (s) => put(s, { auth: null }), "missing_token"],
    ["another scheme", (s) => put(s, { auth: "Basic Zm9vOmJhcg==" }), "missing_token"],
    ["aud = another app", (s) => put(s, { token: { aud: "app_other" } })],
    ["iss = another issuer", (s) => put(s, { token: { iss: "https://evil.example" } })],
    ["expired", (s) => put(s, { token: { iat: now() - 120, exp: now() - 60 } })],
    ["lifetime over 60 s", (s) => put(s, { token: { exp: now() + 300 } })],
    ["typ is not ain-adapter+jwt (an ID or logout token)", (s) => put(s, { token: { typ: "JWT" } })],
    ["signed by an unpublished key", (s) => put(s, { token: { key: "other" } })],
    ["bound to another method", (s) => put(s, { token: { method: "GET" } })],
    ["bound to another URL", (s) => put(s, { token: { url: userUrl(ORG.id, "acc_someone_else") } })],
    ["body tampered after signing", (s) => put(s, { body: JSON.stringify({ ...s, status: "active", appRole: "admin" }) , token: { body: JSON.stringify(s) } })],
  ];
  it.each(cases)("%s", async (_label, send, code = "invalid_token") => {
    const s = desired(`acc_v_${_label.replace(/\W+/g, "_")}`, { status: "suspended", appRole: null, groups: [] });
    const res = await send(s);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe(code);
    expect(membershipCount(s.sub)).toBe(0);
  });

  it("an HS256 token (algorithm confusion) is refused", async () => {
    const s = desired("acc_hs256");
    const body = JSON.stringify(s);
    const token = await new SignJWT({ iss: ISSUER, aud: CLIENT_ID, jti: "j-hs", htm: "PUT", htu: userUrl(ORG.id, s.sub), bsh: "x" })
      .setProtectedHeader({ alg: "HS256", typ: "ain-adapter+jwt" }).setIssuedAt().setExpirationTime("30s").sign(new TextEncoder().encode(CLIENT_SECRET));
    const res = await put(s, { auth: `Bearer ${token}`, body });
    expect(res.status).toBe(401);
    expect(membershipCount(s.sub)).toBe(0);
  });

  it("a replayed token (same jti) is refused after it was used once", async () => {
    const s = desired("acc_replay");
    const body = JSON.stringify(s);
    const url = userUrl(ORG.id, s.sub);
    const token = await issuer.adapterToken({ method: "PUT", url, body, jti: "jti-replay-1" });
    const send = () => handleAdapterUser(new Request(url, { method: "PUT", body, headers: { authorization: `Bearer ${token}` } }), ORG.id, s.sub, { keys: issuer.keys });
    expect((await send()).status).toBe(200);
    const again = await send();
    expect(again.status).toBe(401);
    expect((await again.json()).message).toMatch(/already used/);
  });

  it("htu is checked against the PUBLIC URL (behind the TLS proxy), not the internal one", async () => {
    const s = desired("acc_proxy");
    const res = await put(s, { url: `http://127.0.0.1:3737/api/sso/v1/orgs/${ORG.id}/users/${s.sub}` });
    expect(res.status).toBe(200);
  });

  it("a body for another user/org than the path is 400 invalid_request", async () => {
    const s = desired("acc_path");
    const body = JSON.stringify({ ...s, sub: "acc_other" });
    const url = userUrl(ORG.id, s.sub);
    const token = await issuer.adapterToken({ method: "PUT", url, body });
    const res = await handleAdapterUser(new Request(url, { method: "PUT", body, headers: { authorization: `Bearer ${token}` } }), ORG.id, s.sub, { keys: issuer.keys });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_request");
    expect(membershipCount("acc_path") + membershipCount("acc_other")).toBe(0);
  });

  it("a body that is not a DesiredUserState is 400; an oversized one 413", async () => {
    const s = desired("acc_schema");
    const bad = JSON.stringify({ ...s, status: "deleted" });
    expect((await put(s, { body: bad, token: { body: bad } })).status).toBe(400);
    const huge = JSON.stringify({ ...s, profile: { ...s.profile, name: "x".repeat(70_000) } });
    expect((await put(s, { body: huge, token: { body: huge } })).status).toBe(413);
  });

  it("works through the Next.js route with the issuer's JWKS", async () => {
    oidc.setJwksForTests(oidc.adapterJwksUrl(ISSUER), issuer.keys);
    const s = desired("acc_route");
    const body = JSON.stringify(s);
    const url = userUrl(ORG.id, s.sub);
    const token = await issuer.adapterToken({ method: "PUT", url, body });
    const res = await userRoute.PUT(new Request(url, { method: "PUT", body, headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve({ orgId: ORG.id, sub: s.sub }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("versions (adapter-protocol §4.2)", () => {
  it("applies newer versions, ignores older/equal ones and answers the applied state", async () => {
    const sub = "acc_versions";
    const r1 = await put(desired(sub, { version: 1 }));
    expect(r1.status).toBe(200);
    const a1 = await r1.json();
    expect(a1).toMatchObject({ appliedVersion: 1, status: "active" });

    const r3 = await put(desired(sub, { version: 3, status: "suspended", appRole: null, groups: [] }));
    expect(await r3.json()).toEqual({ appliedVersion: 3, localUserId: a1.localUserId, status: "suspended" });

    // A delayed version 2 arrives after 3: no change, 200 with the applied version.
    const late = await put(desired(sub, { version: 2, status: "active" }));
    expect(late.status).toBe(200);
    expect(await late.json()).toEqual({ appliedVersion: 3, localUserId: a1.localUserId, status: "suspended" });
    expect(store.isAccountBlocked(a1.localUserId)).toBe(true);

    // The same version re-sent (retry) is a no-op.
    expect(await (await put(desired(sub, { version: 3, status: "suspended", appRole: null, groups: [] }))).json()).toEqual({ appliedVersion: 3, localUserId: a1.localUserId, status: "suspended" });

    // Reconciliation read.
    expect(await (await get(ORG.id, sub)).json()).toEqual({ exists: true, localUserId: a1.localUserId, appliedVersion: 3, status: "suspended", appRole: null, groups: [] });
    expect(await (await get(ORG.id, "acc_unknown")).json()).toEqual({ exists: false, localUserId: null, appliedVersion: null, status: null, appRole: null, groups: [] });
  });

  it("records appRole and group slugs (sorted) for an active member; creates the user by sub, not by email", async () => {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("u_same_email", "acc_grp@comcom.example", "Other person", "x");
    const res = await put(desired("acc_grp"));
    const { localUserId } = await res.json();
    expect(localUserId).not.toBe("u_same_email");
    expect(await (await get(ORG.id, "acc_grp")).json()).toMatchObject({ appRole: "member", groups: ["all", "eng"] });
    expect(store.identityFor(ISSUER, "acc_grp")).toMatchObject({ user_id: localUserId, link_method: "provisioned" });
  });
});

describe("legacy mapping (adapter-protocol §4.4)", () => {
  beforeAll(() => {
    for (const id of ["legacy_a", "legacy_b", "legacy_c", "legacy_p", "legacy_q"]) {
      db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run(id, `${id}@example.com`, id, "x");
    }
  });

  it("links the pre-existing account once", async () => {
    const res = await put(desired("acc_la", { legacyUserId: "legacy_a" }));
    expect((await res.json()).localUserId).toBe("legacy_a");
    expect(store.identityFor(ISSUER, "acc_la")).toMatchObject({ user_id: "legacy_a", link_method: "legacy_mapping" });
  });

  it("an unknown legacy user is 409 legacy_user_not_found", async () => {
    const res = await put(desired("acc_lx", { legacyUserId: "nobody" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "legacy_user_not_found", retryable: false });
    expect(store.identityFor(ISSUER, "acc_lx")).toBeUndefined();
  });

  it("a legacy user linked to another AIN account is 409 legacy_conflict — never re-pointed", async () => {
    const res = await put(desired("acc_lb", { legacyUserId: "legacy_a" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("legacy_conflict");
    expect(store.identityFor(ISSUER, "acc_la")!.user_id).toBe("legacy_a");
  });

  it("a rolled-back mapping stops treating the legacy account as this person's", async () => {
    await put(desired("acc_lc", { version: 1, legacyUserId: "legacy_c" }));
    const ses = store.createSsoSession({ userId: "legacy_c", issuer: ISSUER, subject: "acc_lc", oidcSid: "s-lc", orgId: ORG.id, orgIds: [ORG.id] });
    const res = await put(desired("acc_lc", { version: 2, legacyUserId: null }));
    const { localUserId } = await res.json();
    expect(localUserId).not.toBe("legacy_c");
    expect(store.identityFor(ISSUER, "acc_lc")).toMatchObject({ user_id: localUserId, link_method: "provisioned" });
    expect(store.getSsoSession(ses)!.end_reason).toBe("legacy_mapping_rolled_back");
    expect(store.ssoAccountState("legacy_c")).toBe("unmanaged"); // an ordinary account again
    expect(db.prepare("SELECT id FROM users WHERE id = 'legacy_c'").get()).toBeTruthy(); // never deleted
  });
});

describe("a placeholder the adapter made gives way to the legacy account (app attestation linked later)", () => {
  it("never signed in: the next push with legacyUserId re-points the link and the organization state", async () => {
    const first = await (await put(desired("acc_ph", { version: 1 }))).json();
    const placeholder = first.localUserId as string;
    expect(store.identityFor(ISSUER, "acc_ph")).toMatchObject({ user_id: placeholder, link_method: "provisioned", last_login_at: null });
    const res = await put(desired("acc_ph", { version: 2, legacyUserId: "legacy_p" }));
    expect(res.status).toBe(200);
    expect((await res.json()).localUserId).toBe("legacy_p");
    expect(store.identityFor(ISSUER, "acc_ph")).toMatchObject({ user_id: "legacy_p", link_method: "legacy_mapping" });
    expect(db.prepare("SELECT user_id FROM sso_memberships WHERE subject = 'acc_ph'").all()).toEqual([{ user_id: "legacy_p" }]);
    expect(db.prepare("SELECT id FROM users WHERE id = ?").get(placeholder)).toBeTruthy(); // never deleted
    expect(store.ssoAccountState(placeholder)).toBe("unmanaged");
    const ev = db.prepare("SELECT details FROM sso_audit WHERE subject = 'acc_ph' AND action = 'placeholder_replaced'").get() as { details: string };
    expect(JSON.parse(ev.details)).toMatchObject({ placeholderUserId: placeholder, method: "legacy_mapping" });
  });

  it("once someone signed in to it, it is the person's account: a later legacyUserId does not move it", async () => {
    const { localUserId } = await (await put(desired("acc_used", { version: 1 }))).json();
    store.createSsoSession({ userId: localUserId, issuer: ISSUER, subject: "acc_used", oidcSid: "s-used", orgId: ORG.id, orgIds: [ORG.id] });
    const res = await put(desired("acc_used", { version: 2, legacyUserId: "legacy_q" }));
    expect((await res.json()).localUserId).toBe(localUserId);
    expect(store.identityFor(ISSUER, "acc_used")!.user_id).toBe(localUserId);
    expect(store.isSsoLinked("legacy_q")).toBe(false);
  });

  it("the legacy account must exist and be free, as for a first push", async () => {
    await put(desired("acc_ph3", { version: 1 }));
    expect((await (await put(desired("acc_ph3", { version: 2, legacyUserId: "nobody" }))).json()).error).toBe("legacy_user_not_found");
    expect((await (await put(desired("acc_ph3", { version: 3, legacyUserId: "legacy_a" }))).json()).error).toBe("legacy_conflict");
    expect(store.identityFor(ISSUER, "acc_ph3")!.link_method).toBe("provisioned");
  });
});

describe("suspension and offboarding", () => {
  const EMP = "legacy_emp";
  const SUB = "acc_emp";
  let orgPat: string, personalPat: string, orgGrant: string, personalGrant: string, legacyToken: string, ssoToken: string, ssoSession: string, ws: FakeWs;

  beforeAll(async () => {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run(EMP, "emp@example.com", "Emp", await bcrypt.hash("emp-password", 4));
    db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)").run("drive_emp", EMP, "Personal", "h", "s");
    expect((await put(desired(SUB, { version: 1, legacyUserId: EMP }))).status).toBe(200);

    orgPat = mcpTokens.issuePat({ userId: EMP, driveId: "drive_emp", name: "org", scope: "read", ttlDays: 30, ssoOrgId: ORG.id }).token;
    personalPat = mcpTokens.issuePat({ userId: EMP, driveId: "drive_emp", name: "mine", scope: "read", ttlDays: null }).token;
    orgGrant = accountTokens.issueAccountTokens({ userId: EMP, clientId: "c1", clientName: "Org app", scopes: ["profile"], ssoOrgId: ORG.id }).access_token;
    personalGrant = accountTokens.issueAccountTokens({ userId: EMP, clientId: "c2", clientName: "My app", scopes: ["profile"] }).access_token;
    legacyToken = await session.sign(EMP); // browser cookie / CLI pairing / bearer — all the same JWT
    ssoSession = store.createSsoSession({ userId: EMP, issuer: ISSUER, subject: SUB, oidcSid: "sid-emp", orgId: ORG.id, orgIds: [ORG.id] });
    ssoToken = await session.sign(EMP, { ssoSessionId: ssoSession });
    ws = fakeWs();
    await onDocConnect(ws, { headers: { cookie: `aindrive_session=${ssoToken}` } }, { drive: "drive_emp", path: "notes.md" });
    expect(ws.closedWith).toBeNull();
    db.prepare("INSERT INTO cli_link_requests (link_id, device_secret_hash, user_id, expires_at) VALUES (?, ?, ?, datetime('now', '+10 minutes'))")
      .run("link-emp-1", "00", EMP);
    // Sanity: everything works before.
    expect(await session.verify(legacyToken)).toBe(EMP);
    expect(await session.verify(ssoToken)).toBe(EMP);
    expect(mcpTokens.verifyMcpToken(orgPat)).not.toBeNull();
    expect(accountTokens.verifyAccountToken(orgGrant)).not.toBeNull();
  });

  it("suspended: sessions end, org credentials are revoked, personal ones and personal data stay — before the 200", async () => {
    const res = await put(desired(SUB, { version: 2, status: "suspended", appRole: null, groups: [], legacyUserId: EMP }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ appliedVersion: 2, localUserId: EMP, status: "suspended" });

    expect(await session.verify(legacyToken)).toBeNull();
    expect(await session.verify(ssoToken)).toBeNull();
    expect(store.getSsoSession(ssoSession)!.end_reason).toBe("sso_suspended");
    expect(ws.closedWith).toBe(4401);
    expect(db.prepare("SELECT 1 FROM cli_link_requests WHERE link_id = 'link-emp-1'").get()).toBeUndefined();

    expect(mcpTokens.verifyMcpToken(orgPat)).toBeNull();
    expect(accountTokens.verifyAccountToken(orgGrant)).toBeNull();
    expect(mcpTokens.verifyMcpToken(personalPat)).not.toBeNull();
    expect(accountTokens.verifyAccountToken(personalGrant)).not.toBeNull();

    expect(db.prepare("SELECT owner_id FROM drives WHERE id = 'drive_emp'").get()).toEqual({ owner_id: EMP });
    expect(store.ssoAccountState(EMP)).toBe("blocked");
    const audit = db.prepare("SELECT action, actor FROM sso_audit WHERE subject = ? AND action = 'access_revoked'").all(SUB);
    expect(audit).toEqual([{ action: "access_revoked", actor: "ain-sso" }]);
  });

  it("a suspended account cannot sign in on any path — and a new session token cannot even be minted", async () => {
    const login = await loginRoute.POST(new Request(`${PUBLIC_URL}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "emp@example.com", password: "emp-password" }) }));
    expect(login.status).toBe(403);
    expect((await login.json()).error).toBe("account_suspended");
    expect(jar.get("aindrive_session")).toBeUndefined();
    await expect(session.sign(EMP)).rejects.toThrow("account_blocked");
    expect(() => store.createSsoSession({ userId: EMP, issuer: ISSUER, subject: SUB, oidcSid: null, orgId: null, orgIds: [] })).toThrow("account_blocked");

    // A device pairing approved before the suspension is not handed out.
    const secret = "d".repeat(32);
    const { createHash } = await import("node:crypto");
    db.prepare("INSERT INTO cli_link_requests (link_id, device_secret_hash, user_id, expires_at) VALUES (?, ?, ?, datetime('now', '+10 minutes'))")
      .run("link-emp-2", createHash("sha256").update(secret).digest("hex"), EMP);
    const poll = await pollRoute.POST(new Request(`${PUBLIC_URL}/api/auth/cli/poll`, { method: "POST", body: JSON.stringify({ linkId: "link-emp-2", deviceSecret: secret }) }));
    expect(poll.status).toBe(403);
  });

  it("the suspension survives every rollback switch (LEGACY_LOGIN=true, SSO login off, even the issuer unset)", async () => {
    for (const env of [{ AINDRIVE_LEGACY_LOGIN: "true" }, { AINDRIVE_SSO_ENABLED: "false" }, { AINDRIVE_SSO_ISSUER: "" }]) {
      const saved = { ...process.env };
      Object.assign(process.env, env);
      try {
        const login = await loginRoute.POST(new Request(`${PUBLIC_URL}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "emp@example.com", password: "emp-password" }) }));
        expect(login.status).toBe(403);
        expect(await session.verify(legacyToken)).toBeNull();
      } finally {
        for (const k of Object.keys(env)) {
          if (saved[k] === undefined) delete process.env[k];
          else process.env[k] = saved[k];
        }
      }
    }
  });

  it("reactivation restores sign-in; revoked tokens and ended sessions stay dead", async () => {
    expect((await put(desired(SUB, { version: 3, legacyUserId: EMP }))).status).toBe(200);
    expect(store.ssoAccountState(EMP)).toBe("active");
    const login = await loginRoute.POST(new Request(`${PUBLIC_URL}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "emp@example.com", password: "emp-password" }) }));
    expect(login.status).toBe(200);
    expect(await session.verify(jar.get("aindrive_session")!)).toBe(EMP);
    expect(await session.verify(legacyToken)).toBeNull();
    expect(mcpTokens.verifyMcpToken(orgPat)).toBeNull();
    expect(mcpTokens.verifyMcpToken(personalPat)).not.toBeNull();
  });

  it("active in one org and suspended in another: org B's credentials go, the account stays usable", async () => {
    const orgB = { id: "org_b", slug: "b", name: "B" };
    const bPat = mcpTokens.issuePat({ userId: EMP, driveId: "drive_emp", name: "b", scope: "read", ttlDays: 30, ssoOrgId: orgB.id }).token;
    const aPat = mcpTokens.issuePat({ userId: EMP, driveId: "drive_emp", name: "a", scope: "read", ttlDays: 30, ssoOrgId: ORG.id }).token;
    await put(desired(SUB, { org: orgB, version: 1, legacyUserId: EMP }));
    await put(desired(SUB, { org: orgB, version: 2, status: "suspended", appRole: null, groups: [], legacyUserId: EMP }));
    expect(mcpTokens.verifyMcpToken(bPat)).toBeNull();
    expect(mcpTokens.verifyMcpToken(aPat)).not.toBeNull();
    expect(store.ssoAccountState(EMP)).toBe("active");
    expect(await session.sign(EMP)).toBeTruthy();
  });

  it("deprovisioned: org credentials revoked permanently, personal drives never transferred, user never deleted", async () => {
    await put(desired(SUB, { org: { id: "org_b", slug: "b", name: "B" }, version: 3, status: "deprovisioned", appRole: null, groups: [], legacyUserId: EMP, ownershipTransferTo: "acc_heir" }));
    const res = await put(desired(SUB, { version: 4, status: "deprovisioned", appRole: null, groups: [], legacyUserId: EMP, ownershipTransferTo: "acc_heir" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ appliedVersion: 4, localUserId: EMP, status: "deprovisioned" });
    expect(db.prepare("SELECT owner_id FROM drives WHERE id = 'drive_emp'").get()).toEqual({ owner_id: EMP });
    expect(db.prepare("SELECT id FROM users WHERE id = ?").get(EMP)).toBeTruthy();
    expect(mcpTokens.verifyMcpToken(personalPat)).not.toBeNull();
    expect(store.ssoAccountState(EMP)).toBe("blocked");
    const transfer = db.prepare("SELECT details FROM sso_audit WHERE subject = ? AND action = 'ownership_transfer' ORDER BY id DESC").get(SUB) as { details: string };
    expect(JSON.parse(transfer.details)).toMatchObject({ to: "acc_heir", transferred: [] });
  });
});
