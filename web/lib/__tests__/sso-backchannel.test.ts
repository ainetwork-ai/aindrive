// OIDC Back-Channel Logout 1.0: strict logout-token validation, and a `sid`
// ends only the aindrive sessions created with that OIDC session (and their
// open collab sockets); `sub` alone ends every session of the linked account.
import { describe, it, expect, vi, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_ID, cookieJar, createTestIssuer, fakeIssuerFetch, ISSUER, PUBLIC_URL } from "./sso-test-issuer";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-sso-bcl-"));
process.env.AINDRIVE_PUBLIC_URL = PUBLIC_URL;
process.env.AINDRIVE_SESSION_SECRET = "sso-bcl-test-secret-0123456789abcdef";
process.env.AINDRIVE_SSO_ISSUER = ISSUER;
process.env.AINDRIVE_SSO_CLIENT_ID = CLIENT_ID;

const { cookies } = cookieJar();
vi.mock("next/headers", () => ({ cookies }));

const { db } = await import("../db.js");
const session = await import("../session");
const store = await import("../sso/store.js");
const oidc = await import("../sso/oidc");
const { handleBackchannelLogout } = await import("../sso/backchannel");
const route = await import("../../app/api/auth/sso/backchannel-logout/route.js");
const { onDocConnect } = await import("../dochub.js");

const issuer = await createTestIssuer();
const U = "u_bcl";
const SUB = "acc_bcl";
const post = (token: string | null, viaRoute = false) => {
  const req = new Request(`${PUBLIC_URL}/api/auth/sso/backchannel-logout`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: token === null ? "" : new URLSearchParams({ logout_token: token }).toString(),
  });
  return viaRoute ? route.POST(req) : handleBackchannelLogout(req, { keys: issuer.keys });
};
type FakeWs = { closedWith: number | null; readyState: number; OPEN: number; close(code: number): void; send(): void; on(): void };
const fakeWs = (): FakeWs => ({ closedWith: null, readyState: 1, OPEN: 1, close(code) { this.closedWith = code; }, send() {}, on() {} });

let sesA: string, sesB: string, tokA: string, tokB: string, legacy: string, wsA: FakeWs, wsB: FakeWs;
beforeAll(async () => {
  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run(U, "bcl@example.com", "B", "x");
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)").run("drive_bcl", U, "D", "h", "s");
  store.linkExistingUser({ issuer: ISSUER, subject: SUB, userId: U, method: "test", actor: "test" });
  sesA = store.createSsoSession({ userId: U, issuer: ISSUER, subject: SUB, oidcSid: "sid-A", orgId: null, orgIds: [] });
  sesB = store.createSsoSession({ userId: U, issuer: ISSUER, subject: SUB, oidcSid: "sid-B", orgId: null, orgIds: [] });
  tokA = await session.sign(U, { ssoSessionId: sesA });
  tokB = await session.sign(U, { ssoSessionId: sesB });
  legacy = await session.sign(U);
  wsA = fakeWs();
  wsB = fakeWs();
  await onDocConnect(wsA, { headers: { cookie: `aindrive_session=${tokA}` } }, { drive: "drive_bcl", path: "a.md" });
  await onDocConnect(wsB, { headers: { cookie: `aindrive_session=${tokB}` } }, { drive: "drive_bcl", path: "a.md" });
});

describe("logout token validation — 400, nothing ended", () => {
  const now = () => Math.floor(Date.now() / 1000);
  it.each([
    ["no logout_token", async () => post(null)],
    ["not a JWT", async () => post("garbage")],
    ["typ is not logout+jwt (e.g. an ID token)", async () => post(await issuer.logoutToken({ sid: "sid-A" }, { typ: "JWT" }))],
    ["no events claim", async () => post(await issuer.logoutToken({ sid: "sid-A" }, { noEvents: true }))],
    ["carries a nonce", async () => post(await issuer.logoutToken({ sid: "sid-A", nonce: "n" }))],
    ["neither sid nor sub", async () => post(await issuer.logoutToken({}))],
    ["for another client (aud)", async () => post(await issuer.logoutToken({ sid: "sid-A" }, { aud: "app_other" }))],
    ["too old (iat)", async () => post(await issuer.logoutToken({ sid: "sid-A" }, { iat: now() - 600, exp: now() + 60 }))],
    ["from another issuer", async () => post(await issuer.logoutToken({ sid: "sid-A", iss: "https://evil.example" }))],
  ])("%s", async (_l, send) => {
    const res = await send();
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await session.verify(tokA)).toBe(U);
  });
});

describe("ending sessions", () => {
  it("a sid ends only the sessions created with it, and their sockets", async () => {
    const token = await issuer.logoutToken({ sid: "sid-A", sub: SUB });
    const res = await post(token);
    expect(res.status).toBe(200);
    expect(await session.verify(tokA)).toBeNull();
    expect(store.getSsoSession(sesA)!.end_reason).toBe("backchannel_logout");
    expect(wsA.closedWith).toBe(4401);
    // Other sessions of the same person stay.
    expect(await session.verify(tokB)).toBe(U);
    expect(await session.verify(legacy)).toBe(U);
    expect(wsB.closedWith).toBeNull();
    // Replay of the same token is refused.
    expect((await post(token)).status).toBe(400);
  });

  it("sub alone ends every session of the linked account (legacy cookie and pairing tokens too)", async () => {
    const res = await post(await issuer.logoutToken({ sub: SUB }));
    expect(res.status).toBe(200);
    expect(await session.verify(tokB)).toBeNull();
    expect(await session.verify(legacy)).toBeNull();
    expect(wsB.closedWith).toBe(4401);
    // Not a suspension: the person can sign in again.
    expect(store.isAccountBlocked(U)).toBe(false);
    expect(await session.verify(await session.sign(U))).toBe(U);
  });

  it("an unknown sub/sid is acknowledged without effect", async () => {
    expect((await post(await issuer.logoutToken({ sub: "acc_nobody" }))).status).toBe(200);
    expect((await post(await issuer.logoutToken({ sid: "sid-unknown" }))).status).toBe(200);
  });

  it("the route verifies with the issuer's discovered JWKS", async () => {
    vi.stubGlobal("fetch", fakeIssuerFetch(issuer, () => ({})).impl);
    oidc.clearDiscoveryCache();
    oidc.setJwksForTests(issuer.metadata.jwks_uri, issuer.keys);
    const ses = store.createSsoSession({ userId: U, issuer: ISSUER, subject: SUB, oidcSid: "sid-C", orgId: null, orgIds: [] });
    const res = await post(await issuer.logoutToken({ sid: "sid-C" }), true);
    expect(res.status).toBe(200);
    expect(store.getSsoSession(ses)!.ended_at).not.toBeNull();
    vi.unstubAllGlobals();
  });
});
