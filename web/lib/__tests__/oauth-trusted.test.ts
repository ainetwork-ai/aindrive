// Trusted first-party OAuth clients (AINDRIVE_TRUSTED_OAUTH_CLIENTS; lib/oauth.ts
// skipsConsent, lib/oauth-authorize.ts): a person signed in THROUGH AIN SSO
// visiting a trusted client's valid authorization request, within its scope
// ceiling, gets the code without the consent screen — the same code row
// "Allow" makes. A password/Google/wallet session (which another site could
// plant, or which may be another account), a login_hint of another AIN subject,
// money-moving scopes, untrusted clients and invalid requests: as before. An
// anonymous visitor of a trusted client goes through AIN SSO (silent first,
// then AIN's sign-in; /login after a sign-out) and back to the very same
// request; anyone else goes to /login. A suspended or offboarded person never
// gets a code. The operator's list is never garbage-collected and is
// boot-checked.
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { CLIENT_ID, CLIENT_SECRET, cookieJar, createTestIssuer, fakeIssuerFetch, ISSUER, PUBLIC_URL } from "./sso-test-issuer";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-oauth-trusted-"));
process.env.AINDRIVE_PUBLIC_URL = PUBLIC_URL;
process.env.AINDRIVE_SESSION_SECRET = "oauth-trusted-test-secret-0123456789abcdef";
const SSO_ENV = {
  AINDRIVE_SSO_ISSUER: ISSUER,
  AINDRIVE_SSO_CLIENT_ID: CLIENT_ID,
  AINDRIVE_SSO_CLIENT_SECRET: CLIENT_SECRET,
  AINDRIVE_SSO_ENABLED: "true",
};
Object.assign(process.env, SSO_ENV);
process.env.AINDRIVE_SSO_ATTEST = "false";

const { jar, cookies } = cookieJar();
vi.mock("next/headers", () => ({ cookies, headers: () => Promise.resolve(new Headers()) }));

const { db } = await import("../db.js");
const session = await import("../session");
const oauth = await import("../oauth");
const flow = await import("../oauth-authorize");
const trusted = await import("../oauth-trusted.js");
const store = await import("../sso/store.js");
const oidc = await import("../sso/oidc");
const silent = await import("../sso/silent");
const { runBootChecks } = await import("../boot-checks.js");
const startRoute = await import("../../app/api/auth/sso/start/route.js");
const callbackRoute = await import("../../app/api/auth/sso/callback/route.js");
const linkRoute = await import("../../app/api/auth/sso/link/route.js");
const tokenRoute = await import("../../app/api/oauth/token/route.js");
const authorizeRoute = await import("../../app/api/oauth/authorize/route.js");
const logoutRoute = await import("../../app/api/auth/logout/route.js");

const TEAMS_REDIRECT = "https://teams.example.test/api/aindrive/callback";
/** The documented production ceiling for AIN Teams (docs/DEPLOY.md). */
const TEAMS_CEILING = "profile+drives:read";
const OTHER_REDIRECT = "https://other.example.test/callback";
const ORG = { id: "org_ain", slug: "ain", name: "AIN" };
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
let teamsId = "";
let otherId = "";

const issuer = await createTestIssuer();
let lastNonce = "";
let signingIn = "acc_alice";
const fake = fakeIssuerFetch(issuer, async () => ({
  access_token: "at",
  token_type: "Bearer",
  id_token: await issuer.idToken({
    sub: signingIn, nonce: lastNonce, sid: `sid-${signingIn}-${randomBytes(4).toString("hex")}`,
    name: signingIn, email: `${signingIn}@corp.example`, email_verified: true,
    orgs: [{ ...ORG, role: "member", groups: [] }],
  }),
}));

type Params = Record<string, string | null>;
const params = (clientId: string, extra: Params = {}): Params => ({
  response_type: "code", client_id: clientId, redirect_uri: clientId === teamsId ? TEAMS_REDIRECT : OTHER_REDIRECT,
  code_challenge: challenge, code_challenge_method: "S256", scope: "profile drives:read", state: "st-1", resource: null, login_hint: null, ...extra,
});
/** A password, Google or wallet session (no AIN SSO session row behind it). */
const signInAs = async (userId: string) => { jar.set("aindrive_session", await session.sign(userId)); };
const accountCodes = (clientId: string) =>
  db.prepare("SELECT user_id, scope, redirect_uri, code_challenge, sso_org_id, consumed FROM account_oauth_codes WHERE client_id = ? ORDER BY created_at").all(clientId);
const driveCodes = (clientId: string) =>
  db.prepare("SELECT user_id, drive_id, scope, sso_org_id FROM oauth_codes WHERE client_id = ? ORDER BY created_at").all(clientId);
const exchange = (code: string, clientId: string, redirectUri: string) => tokenRoute.POST(new Request(`${PUBLIC_URL}/api/oauth/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier }).toString(),
}));
const allow = (p: Params, extra: Record<string, string> = {}) => authorizeRoute.POST(new Request(`${PUBLIC_URL}/api/oauth/authorize`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: PUBLIC_URL },
  body: JSON.stringify({ ...p, decision: "approve", ...extra }),
}));

/** The client's redirect a step sent the browser to. */
function clientRedirect(step: Awaited<ReturnType<typeof flow.authorizeStep>>, redirectUri: string) {
  expect(step.kind).toBe("redirect");
  if (step.kind !== "redirect") throw new Error("not a redirect");
  const u = new URL(step.location);
  expect(`${u.origin}${u.pathname}`).toBe(redirectUri);
  return u.searchParams;
}
/** Follows a same-origin /api/auth/sso/start location, returning AIN SSO's authorization URL. */
async function start(location: string) {
  const res = await startRoute.GET(new Request(`${PUBLIC_URL}${location}`));
  expect(res.status).toBe(302);
  const url = new URL(res.headers.get("location")!);
  expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/oidc/auth`);
  lastNonce = url.searchParams.get("nonce")!;
  return url;
}
async function callback(q: Record<string, string>) {
  const res = await callbackRoute.GET(new Request(`${PUBLIC_URL}/api/auth/sso/callback?${new URLSearchParams(q)}`));
  return res.headers.get("location")!;
}
/** The browser back on /oauth/authorize at `path`: what the page does now. */
function stepAt(path: string) {
  const u = new URL(path, PUBLIC_URL);
  expect(u.pathname).toBe("/oauth/authorize");
  return flow.authorizeStep(flow.authorizeParamsFrom(Object.fromEntries(u.searchParams)));
}
const startPath = (p: Params, prompt?: "none") =>
  `/api/auth/sso/start?${prompt ? "prompt=none&" : ""}next=${encodeURIComponent(flow.authorizePath(p))}`;
const loginPath = (p: Params) => `/login?next=${encodeURIComponent(flow.authorizePath(p))}`;

/** "Continue with AIN" as `subject` (an AIN-linked account): an AIN SSO session of ORG. */
async function signInWithAin(subject: string) {
  signingIn = subject;
  const auth = await start("/api/auth/sso/start?next=%2F");
  await callback({ code: "c", state: auth.searchParams.get("state")!, iss: ISSUER });
  expect(await session.currentSsoSession()).toMatchObject({ subject, issuer: ISSUER });
}

function linkedUser(userId: string, subject: string) {
  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run(userId, `${subject}@corp.example`, subject, "x");
  db.prepare("INSERT INTO sso_identities (issuer, subject, user_id, link_method, linked_at, last_login_at) VALUES (?,?,?,?,?,?)")
    .run(ISSUER, subject, userId, "jit", Date.now(), Date.now());
}
function push(subject: string, status: "active" | "suspended" | "deprovisioned", version: number) {
  store.applyDesiredState(ISSUER, {
    schema: "ain-sso.adapter.v1", sub: subject, org: ORG, version, status,
    profile: { name: subject, email: null, workEmail: null }, appRole: "member", groups: [],
    legacyUserId: null, ownershipTransferTo: null, issuedAt: new Date().toISOString(),
  });
}

beforeAll(() => {
  vi.stubGlobal("fetch", fake.impl);
  oidc.setJwksForTests(issuer.metadata.jwks_uri, issuer.keys);
  linkedUser("u_alice", "acc_alice");
  linkedUser("u_carol", "acc_carol");
  linkedUser("u_dave", "acc_dave");
  linkedUser("u_erin", "acc_erin");
  linkedUser("u_frank", "acc_frank");
  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES ('u_bob', 'bob@example.com', 'Bob', 'x')").run();
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES ('d1', 'u_alice', 'D1', 'h', 's')").run();
  teamsId = oauth.registerClient("AIN Teams", [TEAMS_REDIRECT]).client_id;
  otherId = oauth.registerClient("AIN Teams", [OTHER_REDIRECT]).client_id; // a name proves nothing
});

beforeEach(() => {
  jar.clear();
  oidc.clearDiscoveryCache();
  Object.assign(process.env, SSO_ENV);
  process.env.AINDRIVE_TRUSTED_OAUTH_CLIENTS = `${teamsId}=${TEAMS_CEILING}`;
  delete process.env.AINDRIVE_SSO_SILENT;
  delete process.env.AINDRIVE_LEGACY_LOGIN;
  signingIn = "acc_alice";
});

describe("AINDRIVE_TRUSTED_OAUTH_CLIENTS", () => {
  it("parses ids with their scope ceilings; unset = nobody", () => {
    expect(trusted.parseTrustedOAuthClients(undefined)).toEqual({ clients: new Map(), bad: [] });
    expect(trusted.parseTrustedOAuthClients(" ")).toEqual({ clients: new Map(), bad: [] });
    const { clients, bad } = trusted.parseTrustedOAuthClients(" aind_client_B=profile+drives:read, aind_client_C=profile drives:read drive:read ");
    expect(bad).toEqual([]);
    expect([...clients]).toEqual([
      ["aind_client_B", ["profile", "drives:read"]],
      ["aind_client_C", ["profile", "drives:read", "drive:read"]],
    ]);
  });

  it("a malformed entry is never trusted, and a client listed twice is trusted by neither entry", () => {
    const { clients, bad } = trusted.parseTrustedOAuthClients("ok_1=profile, bad id=profile, x=, y=openid, ok_2=profile, ok_2=drives:read, http://evil");
    expect([...clients.keys()]).toEqual(["ok_1"]);
    expect(bad).toEqual(["bad id=profile", "x=", "y=openid", "ok_2=drives:read", "http://evil"]);
  });

  it("the ceiling is required, and may not name a scope that moves money", () => {
    // A bare id would let ANY valid scope skip consent — wallet:pay and drives:sell included.
    const { clients, bad } = trusted.parseTrustedOAuthClients("bare, pay=profile+wallet:pay, sell=drives:sell, ok=profile+drives:read+drives:write");
    expect([...clients.keys()]).toEqual(["ok"]);
    expect(bad).toEqual(["bare", "pay=profile+wallet:pay", "sell=drives:sell"]);
    expect([...trusted.CONSENT_ALWAYS_SCOPES].sort()).toEqual(["drives:sell", "wallet:pay"]);
  });

  it("the JS scope list mirrors lib/oauth.ts", () => {
    expect([...trusted.KNOWN_OAUTH_SCOPES].sort()).toEqual([...oauth.SCOPES_SUPPORTED].sort());
  });

  it("a malformed value fails the production boot; a good one passes", () => {
    expect(trusted.trustedOAuthConfigErrors({})).toEqual([]);
    expect(trusted.trustedOAuthConfigErrors({ AINDRIVE_TRUSTED_OAUTH_CLIENTS: `${teamsId}=profile+drives:read` })).toEqual([]);
    expect(trusted.trustedOAuthConfigErrors({ AINDRIVE_TRUSTED_OAUTH_CLIENTS: "a=profile,a=profile" })[0]).toMatch(/AINDRIVE_TRUSTED_OAUTH_CLIENTS .*bad: a=profile\)/);
    expect(trusted.trustedOAuthConfigErrors({ AINDRIVE_TRUSTED_OAUTH_CLIENTS: teamsId })[0]).toMatch(/ceiling is required.*wallet:pay and drives:sell always need consent/);

    const saved = { ...process.env };
    const exit = vi.spyOn(process, "exit").mockImplementation(((code: number) => { throw new Error(`exit ${code}`); }) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.stubEnv("NODE_ENV", "production");
      process.env.AINDRIVE_PUBLIC_URL = PUBLIC_URL;
      process.env.AINDRIVE_TRUSTED_OAUTH_CLIENTS = `${teamsId}=${TEAMS_CEILING}`;
      expect(() => runBootChecks()).not.toThrow();
      for (const badValue of [`${teamsId}=profile+openid`, teamsId, `${teamsId}=profile+wallet:pay`]) {
        err.mockClear();
        process.env.AINDRIVE_TRUSTED_OAUTH_CLIENTS = badValue;
        expect(() => runBootChecks()).toThrow("exit 1");
        expect(err.mock.calls.flat().join("\n")).toMatch(/AINDRIVE_TRUSTED_OAUTH_CLIENTS/);
      }
    } finally {
      vi.unstubAllEnvs();
      exit.mockRestore();
      err.mockRestore();
      Object.assign(process.env, saved);
    }
  });
});

describe("signed in through AIN SSO: a trusted client gets its code without the consent screen", () => {
  it("the code goes to the registered redirect_uri with state and iss, and redeems like any other", async () => {
    await signInWithAin("acc_alice");
    const q = clientRedirect(await flow.authorizeStep(params(teamsId)), TEAMS_REDIRECT);
    expect(q.get("state")).toBe("st-1");
    expect(q.get("iss")).toBe(PUBLIC_URL);
    expect(q.get("error")).toBeNull();
    const res = await exchange(q.get("code")!, teamsId, TEAMS_REDIRECT);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ token_type: "Bearer", scope: "profile drives:read" });
    expect(db.prepare("SELECT user_id, scope FROM account_tokens WHERE client_id = ?").all(teamsId)).toEqual([{ user_id: "u_alice", scope: "profile drives:read" }]);
  });

  it("recorded exactly like a click on Allow: the same code row, org scope included", async () => {
    // An AIN SSO session of an organization, as AIN Teams' people have.
    signingIn = "acc_alice";
    const auth = await start(startPath(params(teamsId)));
    expect(await callback({ code: "c", state: auth.searchParams.get("state")!, iss: ISSUER })).toBe(flow.authorizePath(params(teamsId)));
    const before = accountCodes(teamsId).length;
    clientRedirect(await flow.authorizeStep(params(teamsId)), TEAMS_REDIRECT);
    const auto = accountCodes(teamsId).slice(before);
    const clicked = await allow(params(otherId));
    expect(clicked.status).toBe(200);
    const byClick = accountCodes(otherId).at(-1);
    const shape = { user_id: "u_alice", scope: "profile drives:read", code_challenge: challenge, sso_org_id: ORG.id, consumed: 0 };
    expect(auto).toEqual([{ ...shape, redirect_uri: TEAMS_REDIRECT }]);
    expect(byClick).toEqual({ ...shape, redirect_uri: OTHER_REDIRECT });
  });

  it("a password, Google or wallet session gets the consent screen — another site could have planted it, or it is another account", async () => {
    // Review F1: a cross-site form signs the browser in to the attacker's
    // account, then the victim's AIN Teams starts a connect. Whatever planted
    // the session, only an AIN SSO session skips consent.
    db.prepare("INSERT OR IGNORE INTO users (id, email, name, password_hash) VALUES ('u_mallory', 'mallory@evil.example', 'Mallory', 'x')").run();
    for (const userId of ["u_mallory", "u_bob", "u_alice" /* AIN-linked, but this session is not AIN's */]) {
      await signInAs(userId);
      const before = accountCodes(teamsId).length;
      expect(await flow.authorizeStep(params(teamsId))).toMatchObject({ kind: "consent", user: { id: userId } });
      expect(accountCodes(teamsId)).toHaveLength(before);
    }
    // …where Allow still works: the person saw whose account it is.
    expect((await allow(params(teamsId))).status).toBe(200);
  });

  it("an AIN SSO session that ended, or of another issuer, is no AIN session", async () => {
    await signInWithAin("acc_alice");
    const s = (await session.currentSsoSession())!;
    db.prepare("UPDATE sso_sessions SET issuer = 'https://other-issuer.example' WHERE id = ?").run(s.id);
    expect(await flow.sameAinPerson("u_alice", null)).toBe(false);
    db.prepare("UPDATE sso_sessions SET issuer = ? WHERE id = ?").run(ISSUER, s.id);
    expect(await flow.sameAinPerson("u_alice", null)).toBe(true);
    expect(await flow.sameAinPerson("u_bob", null)).toBe(false); // not this session's user
    store.endSsoSession(s.id, "test");
    expect(await flow.sameAinPerson("u_alice", null)).toBe(false);
  });

  it("login_hint: the code only for that AIN subject; another subject gets the consent screen", async () => {
    await signInWithAin("acc_alice");
    clientRedirect(await flow.authorizeStep(params(teamsId, { login_hint: "acc_alice" })), TEAMS_REDIRECT);
    const before = accountCodes(teamsId).length;
    expect(await flow.authorizeStep(params(teamsId, { login_hint: "acc_frank" }))).toMatchObject({ kind: "consent", user: { id: "u_alice" } });
    expect(accountCodes(teamsId)).toHaveLength(before);
    // It survives the sign-in round trip (the `next` of every path).
    jar.clear();
    const p = params(teamsId, { login_hint: "acc_frank" });
    expect(await flow.authorizeStep(p)).toEqual({ kind: "redirect", location: startPath(p, "none") });
    signingIn = "acc_frank";
    const auth = await start(startPath(p, "none"));
    const back = await callback({ code: "c", state: auth.searchParams.get("state")!, iss: ISSUER });
    expect(new URL(back, PUBLIC_URL).searchParams.get("login_hint")).toBe("acc_frank");
    clientRedirect(await stepAt(back), TEAMS_REDIRECT);
  });

  it("an untrusted client — even one with the same name — still gets the consent screen, and no code", async () => {
    await signInWithAin("acc_alice");
    const before = accountCodes(otherId).length;
    const step = await flow.authorizeStep(params(otherId));
    expect(step).toMatchObject({ kind: "consent", user: { id: "u_alice" }, value: { client: { client_id: otherId }, driveId: null } });
    expect(accountCodes(otherId)).toHaveLength(before);
    delete process.env.AINDRIVE_TRUSTED_OAUTH_CLIENTS; // unset: today's behaviour for every client
    expect((await flow.authorizeStep(params(teamsId))).kind).toBe("consent");
  });

  it.each([
    ["an unregistered redirect_uri", { redirect_uri: "https://teams.example.test/other" }],
    ["a redirect_uri on another host", { redirect_uri: "https://evil.example/api/aindrive/callback" }],
    ["a redirect_uri variant", { redirect_uri: `${TEAMS_REDIRECT}/` }],
    ["no PKCE", { code_challenge: null }],
    ["PKCE plain", { code_challenge_method: "plain" }],
    ["an unknown scope", { scope: "profile openid" }],
    ["drive and account scopes mixed", { scope: "profile drive:read" }],
    ["no scope", { scope: null }],
    ["response_type token", { response_type: "token" }],
    ["an unknown client", { client_id: "aind_client_nope" }],
  ])("%s is an error page exactly as before — no code, no redirect", async (_label, extra) => {
    await signInWithAin("acc_alice");
    const before = accountCodes(teamsId).length;
    const step = await flow.authorizeStep(params(teamsId, extra));
    const v = oauth.validateAuthorize(params(teamsId, extra));
    expect(v.ok).toBe(false);
    expect(step).toEqual({ kind: "invalid", error: v.ok ? "" : v.error });
    expect(accountCodes(teamsId)).toHaveLength(before);
    jar.clear(); // anonymous: still the error, never a sign-in detour
    expect(await flow.authorizeStep(params(teamsId, extra))).toEqual(step);
  });

  it("a scope ceiling bounds what skips consent; a wider request gets the consent screen", async () => {
    await signInWithAin("acc_alice");
    clientRedirect(await flow.authorizeStep(params(teamsId, { scope: "profile" })), TEAMS_REDIRECT);
    clientRedirect(await flow.authorizeStep(params(teamsId, { scope: "drives:read profile" })), TEAMS_REDIRECT);
    expect((await flow.authorizeStep(params(teamsId, { scope: "profile drives:read drives:write" }))).kind).toBe("consent");
    expect((await flow.authorizeStep(params(teamsId, { scope: "profile wallet:pay" }))).kind).toBe("consent");
    // …where Allow works as for anyone.
    const res = await allow(params(teamsId, { scope: "profile drives:write" }));
    expect(new URL((await res.json()).redirect).searchParams.get("code")).toBeTruthy();
    // A malformed list trusts nobody.
    process.env.AINDRIVE_TRUSTED_OAUTH_CLIENTS = `${teamsId}=profile+openid`;
    expect((await flow.authorizeStep(params(teamsId, { scope: "profile" }))).kind).toBe("consent");
  });

  it("payment and sale scopes never skip consent: a bare entry trusts nobody, and no ceiling can list them", async () => {
    // Review F3: a bare `<client_id>` used to trust every scope, wallet:pay and drives:sell included.
    await signInWithAin("acc_alice");
    const money = "profile wallet:pay drives:sell drives:write";
    for (const list of [teamsId, `${teamsId}=profile+wallet:pay+drives:sell+drives:write`]) {
      process.env.AINDRIVE_TRUSTED_OAUTH_CLIENTS = list;
      expect((await flow.authorizeStep(params(teamsId, { scope: money }))).kind).toBe("consent");
      expect((await flow.authorizeStep(params(teamsId, { scope: "profile" }))).kind).toBe("consent"); // a bad list trusts nobody
    }
    process.env.AINDRIVE_TRUSTED_OAUTH_CLIENTS = `${teamsId}=profile+drives:read+drives:write`;
    clientRedirect(await flow.authorizeStep(params(teamsId, { scope: "profile drives:write" })), TEAMS_REDIRECT);
    for (const scope of ["profile wallet:pay", "profile drives:sell"]) {
      expect((await flow.authorizeStep(params(teamsId, { scope }))).kind).toBe("consent");
    }
  });

  it("a drive grant: clamped to the person's role like Allow; no role in the drive → the consent page's refusal", async () => {
    process.env.AINDRIVE_TRUSTED_OAUTH_CLIENTS = `${teamsId}=${TEAMS_CEILING}+drive:read+drive:write`;
    const drive = { resource: `${PUBLIC_URL}/mcp/d/d1`, scope: "drive:read drive:write" };
    await signInWithAin("acc_alice");
    clientRedirect(await flow.authorizeStep(params(teamsId, drive)), TEAMS_REDIRECT);
    expect(driveCodes(teamsId)).toEqual([{ user_id: "u_alice", drive_id: "d1", scope: "write", sso_org_id: ORG.id }]);
    await signInWithAin("acc_frank"); // not a member of d1
    expect(await flow.authorizeStep(params(teamsId, drive))).toMatchObject({ kind: "consent", user: { id: "u_frank" }, value: { driveId: "d1" } });
    expect(driveCodes(teamsId)).toHaveLength(1);
  });

  it("a code for a loopback or private-use-scheme redirect always needs the click (any program there can catch it)", async () => {
    const local = oauth.registerClient("Teams (dev)", ["http://localhost:3000/cb", "ainteams://cb"]).client_id;
    process.env.AINDRIVE_TRUSTED_OAUTH_CLIENTS = `${teamsId}=${TEAMS_CEILING},${local}=${TEAMS_CEILING}`;
    await signInWithAin("acc_alice");
    const at = (redirect_uri: string) => flow.authorizeStep({ ...params(local), redirect_uri });
    expect((await at("ainteams://cb")).kind).toBe("consent");
    clientRedirect(await at("http://localhost:3000/cb"), "http://localhost:3000/cb"); // local development
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect((await at("http://localhost:3000/cb")).kind).toBe("consent");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("the consent page is wired to this flow (source guard)", () => {
    const page = readFileSync(join(__dirname, "../../app/oauth/authorize/page.tsx"), "utf8");
    expect(page).toContain("authorizeStep(params)");
    expect(page).toContain('if (step.kind === "redirect") redirect(step.location);');
    expect(page).not.toMatch(/validateAuthorize|getUser/); // one decision, in lib/oauth-authorize.ts
    const post = readFileSync(join(__dirname, "../../app/api/oauth/authorize/route.ts"), "utf8");
    expect(post).toMatch(/await approve\(v\.value, user\.id/); // Allow and the trusted path share one approval
    expect(post).not.toMatch(/issueCode|issueAccountCode/);
    const lib = readFileSync(join(__dirname, "../oauth-authorize.ts"), "utf8");
    expect(lib).toContain("if (skipsConsent(v.value) && (await sameAinPerson(user.id, params.login_hint))) {");
  });
});

describe("not signed in: through AIN SSO and back to the same request", () => {
  it("SSO login off: /login, as before", async () => {
    for (const k of Object.keys(SSO_ENV)) delete process.env[k];
    expect(await flow.authorizeStep(params(teamsId))).toEqual({ kind: "redirect", location: loginPath(params(teamsId)) });
    expect(await flow.authorizeStep(params(otherId))).toEqual({ kind: "redirect", location: loginPath(params(otherId)) });
  });

  it("trusted, live AIN session: a silent check signs the person in and the same request returns the code", async () => {
    const p = params(teamsId, { state: "xyz/+ =&?", scope: "drives:read profile" });
    const s1 = await flow.authorizeStep(p);
    expect(s1).toEqual({ kind: "redirect", location: startPath(p, "none") });
    const auth = await start(startPath(p, "none"));
    expect(auth.searchParams.get("prompt")).toBe("none");
    expect(jar.get("ain_sso_checked")).toBe("1"); // the loop guard
    const back = await callback({ code: "c", state: auth.searchParams.get("state")!, iss: ISSUER });
    expect(back).toBe(flow.authorizePath(p));
    expect(flow.authorizeParamsFrom(Object.fromEntries(new URL(back, PUBLIC_URL).searchParams))).toEqual(p); // every parameter intact
    const q = clientRedirect(await stepAt(back), TEAMS_REDIRECT);
    expect(q.get("state")).toBe("xyz/+ =&?");
    const tok = await (await exchange(q.get("code")!, teamsId, TEAMS_REDIRECT)).json();
    expect(tok.scope).toBe("profile drives:read");
  });

  it("trusted, no AIN session (login_required): back once, then AIN SSO's sign-in — never stranded on /login", async () => {
    const p = params(teamsId);
    const auth = await start(startPath(p, "none"));
    const back = await callback({ error: "login_required", state: auth.searchParams.get("state")!, iss: ISSUER });
    expect(back).toBe(flow.authorizePath(p));
    expect(jar.get("aindrive_session")).toBeUndefined();
    const s2 = await stepAt(back);
    expect(s2).toEqual({ kind: "redirect", location: startPath(p) });
    const signIn = await start(startPath(p));
    expect(signIn.searchParams.get("prompt")).toBeNull(); // AIN's own sign-in page
    const back2 = await callback({ code: "c", state: signIn.searchParams.get("state")!, iss: ISSUER });
    expect(back2).toBe(flow.authorizePath(p));
    clientRedirect(await stepAt(back2), TEAMS_REDIRECT);
  });

  it("an untrusted client: /login as before — no automatic AIN sign-in; signed in, the consent screen as before", async () => {
    // Review F5: anyone can register a client (named "AIN Teams", even) and
    // link here; a live AIN session must not sign its victim in on the way.
    const p = params(otherId);
    expect(await flow.authorizeStep(p)).toEqual({ kind: "redirect", location: loginPath(p) });
    expect(jar.get("ain_sso_checked")).toBeUndefined();
    // "Continue with AIN" on /login, on purpose: back, and the consent screen.
    const before = accountCodes(otherId).length;
    const auth = await start(startPath(p));
    const signedIn = await callback({ code: "c", state: auth.searchParams.get("state")!, iss: ISSUER });
    expect(await stepAt(signedIn)).toMatchObject({ kind: "consent", user: { id: "u_alice" } });
    expect(accountCodes(otherId)).toHaveLength(before);
  });

  it("after a sign-out of aindrive in this browser: /login, not AIN's sign-in — a later silent-check link does not undo it", async () => {
    // Review F2: AIN's "Stay signed in" (or a legacy sign-out) leaves a live AIN
    // session, which would complete AIN's sign-in without a page.
    const p = params(teamsId);
    await signInWithAin("acc_alice");
    const out = await logoutRoute.POST(new Request(`${PUBLIC_URL}/api/auth/logout?next=%2Fd%2Fx`, { method: "POST", headers: { origin: PUBLIC_URL } }));
    expect(out.status).toBe(303);
    expect(jar.get("aindrive_session")).toBeUndefined();
    expect(jar.get("ain_sso_checked")).toBe("signed_out");
    expect(await flow.authorizeStep(p)).toEqual({ kind: "redirect", location: loginPath(p) });
    // Another site links the browser to a silent check: it runs, but the mark stays.
    await start(startPath(p, "none"));
    expect(jar.get("ain_sso_checked")).toBe("signed_out");
    expect(await flow.authorizeStep(p)).toEqual({ kind: "redirect", location: loginPath(p) });
    // "Continue with AIN" on /login is the person's choice: back, and the code.
    const auth = await start(startPath(p));
    const back = await callback({ code: "c", state: auth.searchParams.get("state")!, iss: ISSUER });
    clientRedirect(await stepAt(back), TEAMS_REDIRECT);
    // A guard from a silent check (not a sign-out) still sends a trusted client to AIN's sign-in.
    jar.clear();
    jar.set("ain_sso_checked", "1");
    expect(await flow.authorizeStep(p)).toEqual({ kind: "redirect", location: startPath(p) });
  });

  it("an AIN account with no aindrive account yet: connect-or-create, then the code; \"Not now\" → /login, not round again", async () => {
    const p = params(teamsId);
    signingIn = "acc_newcomer"; // signed in at AIN, never at aindrive
    const auth = await start(startPath(p, "none"));
    expect(await callback({ code: "c", state: auth.searchParams.get("state")!, iss: ISSUER })).toBe("/sso/link");
    const notNow = store.getPendingLink(jar.get("aindrive_sso_link"))!.next_path; // the link's "Not now"
    expect(notNow).toBe(flow.authorizePath(p));
    expect(await stepAt(notNow)).toEqual({ kind: "redirect", location: loginPath(p) });
    // Same after AIN's interactive sign-in (the silent check had failed).
    jar.clear();
    jar.set("ain_sso_checked", "1");
    expect(await flow.authorizeStep(p)).toEqual({ kind: "redirect", location: startPath(p) });
    const signIn = await start(startPath(p));
    expect(await callback({ code: "c", state: signIn.searchParams.get("state")!, iss: ISSUER })).toBe("/sso/link");
    expect(await stepAt(store.getPendingLink(jar.get("aindrive_sso_link"))!.next_path)).toEqual({ kind: "redirect", location: loginPath(p) });
    // "Create a new account" instead: back to the request, and the code.
    const created = await linkRoute.POST(new Request(`${PUBLIC_URL}/api/auth/sso/link`, {
      method: "POST", headers: { "content-type": "application/json", origin: PUBLIC_URL }, body: JSON.stringify({ method: "new" }),
    }));
    const { redirect } = await created.json();
    expect(redirect).toBe(flow.authorizePath(p));
    clientRedirect(await stepAt(redirect), TEAMS_REDIRECT);
  });

  it("AINDRIVE_SSO_SILENT=false: no silent check — a trusted client's person goes to AIN's sign-in, others to /login", async () => {
    process.env.AINDRIVE_SSO_SILENT = "false";
    expect(await flow.authorizeStep(params(teamsId))).toEqual({ kind: "redirect", location: startPath(params(teamsId)) });
    expect(await flow.authorizeStep(params(otherId))).toEqual({ kind: "redirect", location: loginPath(params(otherId)) });
  });
});

describe("suspended or offboarded through AIN SSO: never a code", () => {
  it.each([
    ["suspended", "u_carol", "acc_carol"],
    ["deprovisioned", "u_dave", "acc_dave"],
  ] as const)("%s: the old session no longer counts, and AIN SSO sign-in refuses", async (status, userId, subject) => {
    await signInAs(userId); // a session from before
    push(subject, "active", 1);
    push(subject, status, 2);
    const p = params(teamsId);
    const step = await flow.authorizeStep(p);
    expect(step).toEqual({ kind: "redirect", location: startPath(p, "none") }); // not signed in any more
    signingIn = subject;
    const auth = await start(startPath(p, "none"));
    const back = await callback({ code: "c", state: auth.searchParams.get("state")!, iss: ISSUER });
    expect(back).toBe(flow.authorizePath(p)); // the silent check ends anonymous
    const s2 = await stepAt(back);
    expect(s2).toEqual({ kind: "redirect", location: startPath(p) });
    const signIn = await start(startPath(p));
    expect(await callback({ code: "c", state: signIn.searchParams.get("state")!, iss: ISSUER })).toBe("/login?sso_error=account_suspended");
    expect(jar.get("aindrive_session")).toBeUndefined();
    expect(db.prepare("SELECT count(*) AS n FROM account_oauth_codes WHERE user_id = ?").get(userId)).toEqual({ n: 0 });
  });

  it("a code a trusted client got in an org session is burned when the org suspends the person", async () => {
    push("acc_erin", "active", 1);
    signingIn = "acc_erin";
    const p = params(teamsId);
    const auth = await start(startPath(p, "none"));
    const back = await callback({ code: "c", state: auth.searchParams.get("state")!, iss: ISSUER });
    const q = clientRedirect(await stepAt(back), TEAMS_REDIRECT);
    push("acc_erin", "suspended", 2);
    const res = await exchange(q.get("code")!, teamsId, TEAMS_REDIRECT);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });
});

describe("housekeeping", () => {
  it("gcOAuth never drops a trusted registration; an unused untrusted one still goes after a week", () => {
    const keep = oauth.registerClient("Operator app", ["https://ops.example.test/cb"]).client_id;
    const drop = oauth.registerClient("Abandoned", ["https://gone.example.test/cb"]).client_id;
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
    db.prepare("UPDATE oauth_clients SET created_at = ? WHERE client_id IN (?, ?)").run(old, keep, drop);
    process.env.AINDRIVE_TRUSTED_OAUTH_CLIENTS = `${teamsId}=${TEAMS_CEILING}, ${keep}=profile`;
    oauth.gcOAuth();
    expect(oauth.getClient(keep)).not.toBeNull();
    expect(oauth.getClient(drop)).toBeNull();
    delete process.env.AINDRIVE_TRUSTED_OAUTH_CLIENTS; // off the list: collected like any other
    oauth.gcOAuth();
    expect(oauth.getClient(keep)).toBeNull();
  });

  it("the page's middleware stays out of /oauth: the authorize page runs its own check", () => {
    expect(silent.isExcludedPath("/oauth/authorize")).toBe(true);
  });
});
