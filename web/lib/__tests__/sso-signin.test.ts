// "Continue with AIN": authorization code + PKCE S256 + state + nonce against
// an in-test issuer; ID-token validation failures; accounts reached by
// (issuer, sub) only — never by email; linking an existing account needs a
// proof (session in this browser or password) and is reported to AIN SSO.
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { decodeJwt, SignJWT } from "jose";
import { CLIENT_ID, CLIENT_SECRET, cookieJar, createTestIssuer, fakeIssuerFetch, ISSUER, PUBLIC_URL, type TokenEndpointCall } from "./sso-test-issuer";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-sso-signin-"));
process.env.AINDRIVE_PUBLIC_URL = PUBLIC_URL;
process.env.AINDRIVE_SESSION_SECRET = "sso-signin-test-secret-0123456789abcdef";
process.env.AINDRIVE_SSO_ISSUER = ISSUER;
process.env.AINDRIVE_SSO_CLIENT_ID = CLIENT_ID;
process.env.AINDRIVE_SSO_CLIENT_SECRET = CLIENT_SECRET;
process.env.AINDRIVE_SSO_ENABLED = "true";

const { jar, cookies } = cookieJar();
vi.mock("next/headers", () => ({ cookies }));

const { db } = await import("../db.js");
const session = await import("../session");
const store = await import("../sso/store.js");
const oidc = await import("../sso/oidc");
const startRoute = await import("../../app/api/auth/sso/start/route.js");
const callbackRoute = await import("../../app/api/auth/sso/callback/route.js");
const linkRoute = await import("../../app/api/auth/sso/link/route.js");
const configRoute = await import("../../app/api/auth/sso/route.js");
const { handleBackchannelLogout } = await import("../sso/backchannel");
const { addInvite, listInvites } = await import("../invites.js");
const { maxRoleInDrive } = await import("../mcp-tokens");

const issuer = await createTestIssuer();
let idTokenFor: (call: TokenEndpointCall, nonce: string) => Promise<string>;
let lastNonce = "";
const fake = fakeIssuerFetch(issuer, async (call) => ({ access_token: "at", token_type: "Bearer", id_token: await idTokenFor(call, lastNonce) }));

const claims = (sub: string, extra: Record<string, unknown> = {}) => async (_c: TokenEndpointCall, nonce: string) =>
  issuer.idToken({ sub, nonce, sid: `sid-${sub}`, name: "Kim Minji", email: `${sub}@corp.example`, email_verified: true, ...extra });

beforeAll(() => {
  vi.stubGlobal("fetch", fake.impl);
  oidc.setJwksForTests(issuer.metadata.jwks_uri, issuer.keys);
});
beforeEach(() => {
  jar.clear();
  oidc.clearDiscoveryCache();
  (globalThis as { __rl_buckets__?: Map<unknown, unknown> }).__rl_buckets__?.clear();
  delete process.env.AINDRIVE_LEGACY_LOGIN;
});

/** Runs /start and returns the authorization request's parameters. */
async function start(next = "/d/abc") {
  const res = await startRoute.GET(new Request(`${PUBLIC_URL}/api/auth/sso/start?next=${encodeURIComponent(next)}`));
  expect(res.status).toBe(302);
  const url = new URL(res.headers.get("location")!);
  lastNonce = url.searchParams.get("nonce")!;
  return url;
}
const callback = (params: Record<string, string>) =>
  callbackRoute.GET(new Request(`${PUBLIC_URL}/api/auth/sso/callback?${new URLSearchParams(params)}`));
const link = (body: unknown, origin = PUBLIC_URL) =>
  linkRoute.POST(new Request(`${PUBLIC_URL}/api/auth/sso/link`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) }));
async function signIn(sub: string, extra: Record<string, unknown> = {}, next = "/d/abc") {
  idTokenFor = claims(sub, extra);
  const auth = await start(next);
  return callback({ code: `code-${sub}`, state: auth.searchParams.get("state")!, iss: ISSUER });
}
const where = (res: Response) => res.headers.get("location");
const backchannel = async (c: Record<string, unknown>) =>
  handleBackchannelLogout(new Request(`${PUBLIC_URL}/api/auth/sso/backchannel-logout`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ logout_token: await issuer.logoutToken(c) }).toString(),
  }), { keys: issuer.keys });

describe("authorization request", () => {
  it("the login page learns SSO is on", async () => {
    const res = configRoute.GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, legacyLogin: "true" });
  });

  it("uses code + PKCE S256 + state + nonce with scopes openid profile email org", async () => {
    const url = await start();
    expect(url.origin + url.pathname).toBe(issuer.metadata.authorization_endpoint);
    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe(CLIENT_ID);
    expect(p.get("redirect_uri")).toBe(`${PUBLIC_URL}/api/auth/sso/callback`);
    expect(p.get("scope")).toBe("openid profile email org");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("state")!.length).toBeGreaterThanOrEqual(43);
    expect(p.get("nonce")!.length).toBeGreaterThanOrEqual(43);
    // The pending values live server-side; the browser only holds an opaque id.
    const txId = jar.get("aindrive_sso_tx")!;
    const row = db.prepare("SELECT * FROM sso_login_requests WHERE id = ?").get(txId) as { state: string; code_verifier: string; next_path: string };
    expect(row.state).toBe(p.get("state"));
    expect(createHash("sha256").update(row.code_verifier).digest("base64url")).toBe(p.get("code_challenge"));
    expect(row.next_path).toBe("/d/abc");
  });

  it("an open-redirect `next` is neutralised", async () => {
    await start("https://evil.example/x");
    const row = db.prepare("SELECT next_path FROM sso_login_requests WHERE id = ?").get(jar.get("aindrive_sso_tx")!) as { next_path: string };
    expect(row.next_path).toBe("/");
  });
});

describe("callback: first sign-in, then returning", () => {
  it("exchanges the code with client_secret_basic and the PKCE verifier, then asks to connect or create", async () => {
    fake.tokenCalls.length = 0;
    idTokenFor = claims("acc_new1");
    const auth = await start();
    const verifier = (db.prepare("SELECT code_verifier FROM sso_login_requests WHERE id = ?").get(jar.get("aindrive_sso_tx")!) as { code_verifier: string }).code_verifier;
    const res = await callback({ code: "c1", state: auth.searchParams.get("state")!, iss: ISSUER });
    expect(res.status).toBe(303);
    expect(where(res)).toBe("/sso/link");
    const call = fake.tokenCalls.at(-1)!;
    expect(call.authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
    expect(Object.fromEntries(call.body)).toEqual({ grant_type: "authorization_code", code: "c1", redirect_uri: `${PUBLIC_URL}/api/auth/sso/callback`, code_verifier: verifier });
    expect(jar.get("aindrive_sso_tx")).toBeUndefined(); // one-time
    expect(jar.get("aindrive_sso_link")).toBeTruthy();
    expect(jar.get("aindrive_session")).toBeUndefined(); // no account decided yet
  });

  it("'create' makes an account linked by (issuer, sub) with a session keyed by the OIDC sid", async () => {
    await signIn("acc_new2", { orgs: [{ id: "org_1", slug: "comcom", name: "ComCom", role: "member", groups: [] }] });
    const res = await link({ method: "new" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirect: "/d/abc" });
    const ident = store.identityFor(ISSUER, "acc_new2")!;
    expect(ident.link_method).toBe("jit");
    const user = await session.getUser();
    expect(user?.id).toBe(ident.user_id);
    expect(user?.email).toBe("acc_new2@corp.example"); // verified + free → contact email
    const payload = decodeJwt(jar.get("aindrive_session")!);
    const row = store.getSsoSession(payload.ses as string)!;
    expect(row).toMatchObject({ user_id: ident.user_id, subject: "acc_new2", oidc_sid: "sid-acc_new2", org_id: "org_1", ended_at: null });
  });

  it("a returning AIN account signs straight in (no second account)", async () => {
    const before = store.identityFor(ISSUER, "acc_new2")!.user_id;
    const res = await signIn("acc_new2", {}, "/d/xyz");
    expect(where(res)).toBe("/d/xyz");
    expect((await session.getUser())?.id).toBe(before);
    expect((db.prepare("SELECT count(*) c FROM sso_identities WHERE subject = 'acc_new2'").get() as { c: number }).c).toBe(1);
  });
});

describe("callback: rejected responses", () => {
  async function expectError(code: string, mutate: (auth: URL) => Record<string, string>, extra?: Parameters<typeof claims>[1], tokenOverride?: typeof idTokenFor) {
    idTokenFor = tokenOverride ?? claims("acc_bad", extra);
    const auth = await start();
    const res = await callback(mutate(auth));
    expect(where(res)).toBe(`/login?sso_error=${code}`);
    expect(jar.get("aindrive_session")).toBeUndefined();
    expect(store.identityFor(ISSUER, "acc_bad")).toBeUndefined();
  }
  const ok = (auth: URL) => ({ code: "c", state: auth.searchParams.get("state")!, iss: ISSUER });

  it("state mismatch", () => expectError("state_mismatch", (a) => ({ ...ok(a), state: "forged" })));
  it("missing state", () => expectError("state_mismatch", () => ({ code: "c", iss: ISSUER })));
  it("RFC 9207 iss from another issuer (mix-up)", () => expectError("issuer_mismatch", (a) => ({ ...ok(a), iss: "https://evil.example" })));
  it("RFC 9207 iss missing although the issuer advertises it", () => expectError("issuer_missing", (a) => ({ code: "c", state: a.searchParams.get("state")! })));
  it("an error response (unassigned user)", () => expectError("access_denied", (a) => ({ error: "access_denied", state: a.searchParams.get("state")!, iss: ISSUER })));
  it("nonce mismatch", () => expectError("invalid_id_token", ok, undefined, async () => issuer.idToken({ sub: "acc_bad", nonce: "other-nonce" })));
  it("ID token for another client (aud)", () => expectError("invalid_id_token", ok, { aud: "someone-else" }));
  it("ID token from another issuer", () => expectError("invalid_id_token", ok, { iss: "https://evil.example" }));
  it("expired ID token", () => expectError("invalid_id_token", ok, undefined, async (_c, nonce) =>
    issuer.idToken({ sub: "acc_bad", nonce }, { iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 })));
  it("ID token signed by a key the issuer does not publish", () => expectError("invalid_id_token", ok, undefined, async (_c, nonce) =>
    issuer.idToken({ sub: "acc_bad", nonce }, { key: "other" })));
  it("HS256 ID token (algorithm confusion)", () => expectError("invalid_id_token", ok, undefined, async (_c, nonce) =>
    new SignJWT({ iss: ISSUER, aud: CLIENT_ID, sub: "acc_bad", nonce }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("5m")
      .sign(new TextEncoder().encode(CLIENT_SECRET))));
  it("several audiences without azp = us", () => expectError("invalid_id_token", ok, { aud: [CLIENT_ID, "other"], azp: "other" }));

  it("a callback without this browser's pending request, or replayed, is refused", async () => {
    idTokenFor = claims("acc_bad");
    const auth = await start();
    const params = ok(auth);
    const txId = jar.get("aindrive_sso_tx")!;
    jar.delete("aindrive_sso_tx"); // another browser (no pending request)
    expect(where(await callback(params))).toBe("/login?sso_error=expired");
    jar.set("aindrive_sso_tx", txId);
    expect(where(await callback(params))).toBe("/sso/link"); // the real browser
    jar.set("aindrive_sso_tx", txId); // replay: the pending request was one-time
    expect(where(await callback(params))).toBe("/login?sso_error=expired");
  });
});

describe("no email linking", () => {
  it("an AIN login whose verified email equals an existing account's email creates a SEPARATE account", async () => {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("legacy_bob", "bob@corp.example", "Bob", "x");
    await signIn("acc_bob", { email: "bob@corp.example", email_verified: true });
    const res = await link({ method: "new" });
    expect(res.status).toBe(200);
    const ident = store.identityFor(ISSUER, "acc_bob")!;
    expect(ident.user_id).not.toBe("legacy_bob");
    const created = db.prepare("SELECT email FROM users WHERE id = ?").get(ident.user_id) as { email: string };
    expect(created.email).toMatch(/@sso\.aindrive\.local$/); // placeholder; bob's address stays bob's
    expect(store.isSsoLinked("legacy_bob")).toBe(false);
  });

  it("an unverified email is never used, even as contact data", async () => {
    await signIn("acc_unverified", { email: "free@corp.example", email_verified: false });
    await link({ method: "new" });
    const u = db.prepare("SELECT email FROM users WHERE id = ?").get(store.identityFor(ISSUER, "acc_unverified")!.user_id) as { email: string };
    expect(u.email).toMatch(/@sso\.aindrive\.local$/);
  });
});

describe("connecting an existing (legacy) account needs a proof", () => {
  beforeAll(async () => {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("legacy_sess", "sess@example.com", "Sess", "x");
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("legacy_pw", "pw@example.com", "Pw", await bcrypt.hash("right-password", 4));
  });

  it("the session this browser already has (legacy_session), reported to AIN SSO", async () => {
    fake.appProofs.length = 0;
    await signIn("acc_sess");
    jar.set("aindrive_session", await session.sign("legacy_sess")); // signed in to aindrive the old way
    const res = await link({ method: "legacy_session" });
    expect(res.status).toBe(200);
    expect(store.identityFor(ISSUER, "acc_sess")).toMatchObject({ user_id: "legacy_sess", link_method: "app_proof:legacy_session" });
    expect(decodeJwt(jar.get("aindrive_session")!).ses).toBeTruthy(); // now an SSO session
    await vi.waitFor(() => expect(fake.appProofs).toHaveLength(1));
    expect(fake.appProofs[0].body).toEqual({ sub: "acc_sess", legacyUserId: "legacy_sess", method: "legacy_session" });
    expect(fake.appProofs[0].authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
  });

  it("the legacy password (wrong password links nothing)", async () => {
    await signIn("acc_pw");
    expect((await link({ method: "legacy_password", email: "pw@example.com", password: "wrong" })).status).toBe(401);
    expect(store.identityFor(ISSUER, "acc_pw")).toBeUndefined();
    const res = await link({ method: "legacy_password", email: "PW@example.com", password: "right-password" });
    expect(res.status).toBe(200);
    expect(store.identityFor(ISSUER, "acc_pw")).toMatchObject({ user_id: "legacy_pw", link_method: "app_proof:legacy_password" });
  });

  it("an account already linked to another AIN account is never re-pointed", async () => {
    await signIn("acc_intruder");
    const res = await link({ method: "legacy_password", email: "pw@example.com", password: "right-password" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("account_already_linked");
    expect(store.identityFor(ISSUER, "acc_pw")!.user_id).toBe("legacy_pw");
    expect(store.identityFor(ISSUER, "acc_intruder")).toBeUndefined();
  });

  it("cross-origin requests are refused (CSRF)", async () => {
    await signIn("acc_csrf");
    expect((await link({ method: "new" }, "https://evil.example")).status).toBe(403);
  });

  it("AINDRIVE_LEGACY_LOGIN=false: no legacy proof — the account is created directly", async () => {
    process.env.AINDRIVE_LEGACY_LOGIN = "false";
    const res = await signIn("acc_direct");
    expect(where(res)).toBe("/d/abc");
    expect(store.identityFor(ISSUER, "acc_direct")?.link_method).toBe("jit");
    expect((await session.getUser())?.id).toBe(store.identityFor(ISSUER, "acc_direct")!.user_id);
  });
});

describe("suspended accounts", () => {
  it("a linked account suspended through AIN SSO cannot sign in with AIN either", async () => {
    const userId = store.identityFor(ISSUER, "acc_new2")!.user_id;
    db.prepare(`INSERT INTO sso_memberships (issuer, org_id, subject, user_id, status, applied_version, updated_at)
                VALUES (?, 'org_s', 'acc_new2', ?, 'suspended', 1, ?)`).run(ISSUER, userId, Date.now());
    const res = await signIn("acc_new2");
    expect(where(res)).toBe("/login?sso_error=account_suspended");
    expect(jar.get("aindrive_session")).toBeUndefined();
  });
});

describe("back-channel logout while the sign-in waits on /sso/link", () => {
  it("the AIN session (sid) ended: 'connect or create' can no longer be finished at this browser", async () => {
    expect(where(await signIn("acc_pend"))).toBe("/sso/link");
    expect((await backchannel({ sid: "sid-acc_pend", sub: "acc_pend" })).status).toBe(200);
    for (const body of [{ method: "new" }, { method: "legacy_session" }]) {
      const res = await link(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "expired" });
    }
    expect(store.identityFor(ISSUER, "acc_pend")).toBeUndefined();
    expect(await session.getUser()).toBeNull();
    const ev = db.prepare("SELECT details FROM sso_audit WHERE action = 'backchannel_logout' AND subject = 'acc_pend'").get() as { details: string };
    expect(JSON.parse(ev.details)).toMatchObject({ sid: "sid-acc_pend", pendingLinks: 1 });
  });

  it("sub alone (sign-out everywhere, suspension) cancels that AIN account's waiting sign-ins too", async () => {
    expect(where(await signIn("acc_pend2"))).toBe("/sso/link");
    expect((await backchannel({ sub: "acc_pend2" })).status).toBe(200);
    expect((await link({ method: "new" })).status).toBe(400);
    expect(store.identityFor(ISSUER, "acc_pend2")).toBeUndefined();
  });

  it("another OIDC session's logout leaves the waiting sign-in alone", async () => {
    expect(where(await signIn("acc_pend3"))).toBe("/sso/link");
    expect((await backchannel({ sid: "sid-someone-else" })).status).toBe(200);
    expect((await link({ method: "new" })).status).toBe(200);
  });
});

describe("drive invites pending for the address of an account created through AIN", () => {
  beforeAll(() => {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("u_inv_owner", "inv-owner@example.com", "O", "x");
    db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)").run("drive_inv", "u_inv_owner", "Team", "h", "s");
  });
  const role = (userId: string, path = "") => db.prepare("SELECT role FROM drive_members WHERE drive_id = 'drive_inv' AND user_id = ? AND path = ?").get(userId, path) as { role: string } | undefined;

  it("sign-up with AIN (legacy login off) claims them, as a legacy sign-up does", async () => {
    addInvite("drive_inv", "acc_inv1@corp.example", "", "viewer", "u_inv_owner");
    addInvite("drive_inv", "ACC_INV1@corp.example", "docs", "editor", "u_inv_owner");
    process.env.AINDRIVE_LEGACY_LOGIN = "false";
    expect(where(await signIn("acc_inv1"))).toBe("/d/abc");
    const me = (await session.getUser())!;
    expect(me.email).toBe("acc_inv1@corp.example");
    expect(maxRoleInDrive("drive_inv", me.id)).toBe("editor");
    expect(role(me.id)).toEqual({ role: "viewer" });
    expect(role(me.id, "docs")).toEqual({ role: "editor" });
    expect(listInvites("drive_inv")).toEqual([]);
  });

  it("'create' on /sso/link claims them too", async () => {
    addInvite("drive_inv", "acc_inv2@corp.example", "", "viewer", "u_inv_owner");
    expect(where(await signIn("acc_inv2"))).toBe("/sso/link");
    expect((await link({ method: "new" })).status).toBe(200);
    const me = (await session.getUser())!;
    expect(role(me.id)).toEqual({ role: "viewer" });
    expect(listInvites("drive_inv")).toEqual([]);
  });

  it("an address AIN did not verify, or one the new account could not take, claims nothing", async () => {
    addInvite("drive_inv", "acc_inv3@corp.example", "", "viewer", "u_inv_owner");
    process.env.AINDRIVE_LEGACY_LOGIN = "false";
    await signIn("acc_inv3", { email_verified: false });
    expect(role((await session.getUser())!.id)).toBeUndefined();
    jar.clear();
    addInvite("drive_inv", "taken-inv@corp.example", "", "viewer", "u_inv_owner");
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES ('u_taken_inv', 'taken-inv@corp.example', 'T', 'x')").run();
    await signIn("acc_inv4", { email: "taken-inv@corp.example" });
    expect(role((await session.getUser())!.id)).toBeUndefined();
    expect((listInvites("drive_inv") as { email: string }[]).map((i) => i.email).sort()).toEqual(["acc_inv3@corp.example", "taken-inv@corp.example"]);
  });
});
