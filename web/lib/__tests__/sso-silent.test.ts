// Silent AIN SSO (automatic sign-in, lib/sso/silent.ts + middleware.ts): an
// anonymous browser opening a page is sent ONCE to the start route with
// prompt=none (loop guard cookie set before the redirect); the callback turns
// login_required & co. into an anonymous visit of the same page, and a live
// AIN session into the normal "Continue with AIN" sign-in. API calls, static
// files, sign-in pages, OAuth/MCP, bots, prefetches and RSC requests are
// never touched, and nothing happens unless SSO sign-in is configured.
// Also: prompt=create / ain_idp=google on the start route, "Not now"-safe
// placeholders, the loop-guard cookie on sign-out, and a session cookie that
// died server-side (the page repeats the check the middleware skipped).
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { CLIENT_ID, CLIENT_SECRET, cookieJar, createTestIssuer, fakeIssuerFetch, ISSUER, PUBLIC_URL, type TokenEndpointCall } from "./sso-test-issuer";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-sso-silent-"));
process.env.AINDRIVE_PUBLIC_URL = PUBLIC_URL;
process.env.AINDRIVE_SESSION_SECRET = "sso-silent-test-secret-0123456789abcdef";
const SSO_ENV = {
  AINDRIVE_SSO_ISSUER: ISSUER,
  AINDRIVE_SSO_CLIENT_ID: CLIENT_ID,
  AINDRIVE_SSO_CLIENT_SECRET: CLIENT_SECRET,
  AINDRIVE_SSO_ENABLED: "true",
};
Object.assign(process.env, SSO_ENV);
process.env.AINDRIVE_SSO_ATTEST = "false";

const { jar, cookies } = cookieJar();
/** The page request's headers, as next/headers headers() gives them to a server component. */
let pageHeaders = new Headers();
vi.mock("next/headers", () => ({ cookies, headers: () => Promise.resolve(pageHeaders) }));

const { db } = await import("../db.js");
const session = await import("../session");
const store = await import("../sso/store.js");
const oidc = await import("../sso/oidc");
const silent = await import("../sso/silent");
const { default: middleware } = await import("../../middleware");
const startRoute = await import("../../app/api/auth/sso/start/route.js");
const callbackRoute = await import("../../app/api/auth/sso/callback/route.js");
const linkRoute = await import("../../app/api/auth/sso/link/route.js");
const logoutRoute = await import("../../app/api/auth/logout/route.js");
const meRoute = await import("../../app/api/auth/me/route.js");
const { handleBackchannelLogout } = await import("../sso/backchannel");
const { staleSessionCheck } = await import("../sso/stale-session");

const issuer = await createTestIssuer();
let idTokenFor: (call: TokenEndpointCall, nonce: string) => Promise<string>;
let lastNonce = "";
const fake = fakeIssuerFetch(issuer, async (call) => ({ access_token: "at", token_type: "Bearer", id_token: await idTokenFor(call, lastNonce) }));
const claims = (sub: string) => async (_c: TokenEndpointCall, nonce: string) =>
  issuer.idToken({ sub, nonce, sid: `sid-${sub}`, name: "Kim Minji", email: `${sub}@corp.example`, email_verified: true });

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const NAV = {
  "user-agent": CHROME,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
};

/** A request as the middleware sees it. `cookie` is a raw Cookie header. */
function page(path: string, o: { method?: string; headers?: Record<string, string | null>; cookie?: string } = {}) {
  const headers = new Headers();
  for (const [k, v] of Object.entries({ ...NAV, ...(o.headers ?? {}) })) if (v !== null) headers.set(k, v);
  if (o.cookie) headers.set("cookie", o.cookie);
  return new NextRequest(`${PUBLIC_URL}${path}`, { method: o.method ?? "GET", headers });
}
const isRedirect = (res: Response) => res.status === 302 && !!res.headers.get("location")?.includes("/api/auth/sso/start");
const where = (res: Response) => res.headers.get("location");

beforeAll(() => {
  vi.stubGlobal("fetch", fake.impl);
  oidc.setJwksForTests(issuer.metadata.jwks_uri, issuer.keys);
});
beforeEach(() => {
  jar.clear();
  oidc.clearDiscoveryCache();
  Object.assign(process.env, SSO_ENV);
  delete process.env.AINDRIVE_SSO_SILENT;
  delete process.env.AINDRIVE_LEGACY_LOGIN;
});

describe("middleware: the one redirect", () => {
  it("an anonymous browser opening a page goes to the start route with prompt=none and returnTo = the page", async () => {
    const res = await middleware(page("/d/abc?path=docs%2Fa.md"));
    expect(res.status).toBe(302);
    const loc = new URL(where(res)!);
    expect(loc.origin).toBe(PUBLIC_URL); // the public origin, not the bind address
    expect(loc.pathname).toBe("/api/auth/sso/start");
    expect(loc.searchParams.get("prompt")).toBe("none");
    expect(loc.searchParams.get("next")).toBe("/d/abc?path=docs%2Fa.md");
    expect(res.headers.get("cache-control")).toBe("no-store");
    // The loop guard is set on this very response, before the browser leaves.
    const c = res.cookies.get("ain_sso_checked")!;
    expect(c).toMatchObject({ value: "1", httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 1800 });
  });

  it("the landing page and public share pages are checked too; HEAD like GET", async () => {
    expect(isRedirect(await middleware(page("/")))).toBe(true);
    expect(isRedirect(await middleware(page("/s/tok123")))).toBe(true);
    expect(isRedirect(await middleware(page("/docs/getting-started", { method: "HEAD" })))).toBe(true);
  });

  it("loop protection: with the cookie there is no second check", async () => {
    const first = await middleware(page("/d/abc"));
    const c = first.cookies.get("ain_sso_checked")!;
    const again = await middleware(page("/d/abc", { cookie: `${c.name}=${c.value}` }));
    expect(again.status).toBe(200);
    expect(again.headers.get("x-middleware-next")).toBe("1");
    expect(again.headers.get("content-security-policy")).toBeTruthy(); // the normal page path
  });

  it("a browser with an aindrive session is never redirected", async () => {
    expect((await middleware(page("/d/abc", { cookie: "aindrive_session=eyJ.x.y" }))).status).toBe(200);
  });

  it("an open-redirect-shaped path still returns same-origin", async () => {
    const res = await middleware(page("//evil.example/x"));
    expect(res.status).toBe(302);
    expect(new URL(where(res)!).searchParams.get("next")).toBe("/");
  });

  it.each([
    ["API", "/api/drives"],
    ["framework assets", "/_next/static/chunks/main.js"],
    ["static file", "/favicon.ico"],
    ["monaco asset", "/monaco/vs/loader.js"],
    ["sign-in page", "/login"],
    ["wallet sign-in page", "/login/wallet"],
    ["sign-up page", "/signup"],
    ["password recovery", "/forgot-password"],
    ["SSO link page", "/sso/link"],
    ["OAuth consent (MCP clients)", "/oauth/authorize?client_id=x&redirect_uri=y"],
    ["CLI pairing", "/cli-login/abc"],
    ["MCP endpoint", "/mcp/d/abc"],
    ["A2A endpoint", "/a2a/d/abc"],
    ["AG-UI endpoint", "/agui"],
    ["well-known", "/.well-known/oauth-authorization-server"],
    ["download", "/download/mac"],
  ])("%s is untouched (%s)", async (_label, path) => {
    const res = await middleware(page(path));
    expect(res.status).toBe(200);
    expect(res.cookies.get("ain_sso_checked")).toBeUndefined();
  });

  it.each([
    ["POST", { method: "POST" }],
    ["Googlebot", { headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" } }],
    ["Slack unfurler", { headers: { "user-agent": "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" } }],
    ["Twitter card", { headers: { "user-agent": "Mozilla/5.0 (compatible; Twitterbot/1.0)" } }],
    ["facebook", { headers: { "user-agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)" } }],
    ["headless browser", { headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36" } }],
    ["curl", { headers: { "user-agent": "curl/8.5.0", accept: "*/*", "sec-fetch-mode": null, "sec-fetch-dest": null } }],
    ["no user agent", { headers: { "user-agent": null } }],
    ["API client (no text/html)", { headers: { accept: "application/json", "sec-fetch-mode": null, "sec-fetch-dest": null } }],
    ["fetch()", { headers: { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" } }],
    ["iframe", { headers: { "sec-fetch-dest": "iframe" } }],
    ["Sec-Purpose: prefetch", { headers: { "sec-purpose": "prefetch" } }],
    ["Sec-Purpose: prefetch;prerender", { headers: { "sec-purpose": "prefetch;prerender" } }],
    ["Purpose: prefetch", { headers: { purpose: "prefetch" } }],
    ["Next.js RSC navigation", { headers: { rsc: "1" } }],
    ["Next.js router prefetch", { headers: { "next-router-prefetch": "1" } }],
  ] as const)("%s is never redirected", async (_label, o) => {
    const res = await middleware(page("/d/abc", o as Parameters<typeof page>[1]));
    expect(res.status).toBe(200);
    expect(res.cookies.get("ain_sso_checked")).toBeUndefined();
  });

  it("an RSC request marked only by ?_rsc= is never redirected", async () => {
    expect((await middleware(page("/d/abc?_rsc=1x2y"))).status).toBe(200);
  });

  it("off unless SSO sign-in is configured AND enabled; AINDRIVE_SSO_SILENT=false turns only this off", async () => {
    delete process.env.AINDRIVE_SSO_ENABLED;
    expect((await middleware(page("/d/abc"))).status).toBe(200);
    process.env.AINDRIVE_SSO_ENABLED = "false";
    expect((await middleware(page("/d/abc"))).status).toBe(200);
    process.env.AINDRIVE_SSO_ENABLED = "true";
    delete process.env.AINDRIVE_SSO_CLIENT_SECRET;
    expect((await middleware(page("/d/abc"))).status).toBe(200);
    Object.assign(process.env, SSO_ENV);
    process.env.AINDRIVE_SSO_SILENT = "false";
    expect((await middleware(page("/d/abc"))).status).toBe(200);
    for (const k of Object.keys(SSO_ENV)) delete process.env[k];
    expect((await middleware(page("/d/abc"))).status).toBe(200);
  });

  it("the Edge-side switch mirrors the server's sign-in config", async () => {
    const { ssoLoginEnabled } = await import("../sso/config");
    const envs: Record<string, string | undefined>[] = [
      {},
      { ...SSO_ENV },
      { ...SSO_ENV, AINDRIVE_SSO_ENABLED: "1" },
      { ...SSO_ENV, AINDRIVE_SSO_ENABLED: "false" },
      { ...SSO_ENV, AINDRIVE_SSO_CLIENT_SECRET: "" },
      { ...SSO_ENV, AINDRIVE_SSO_ISSUER: "https://sso.example.test/?x=1" },
      { ...SSO_ENV, AINDRIVE_SSO_ISSUER: "ftp://sso.example.test" },
      { ...SSO_ENV, AINDRIVE_SSO_ISSUER: "not a url" },
    ];
    const saved = { ...process.env };
    try {
      for (const e of envs) {
        for (const k of Object.keys(SSO_ENV)) delete process.env[k];
        Object.assign(process.env, e);
        expect(silent.silentSsoEnabled(process.env)).toBe(ssoLoginEnabled());
      }
    } finally {
      Object.assign(process.env, saved);
    }
  });
});

/** Runs /start as the middleware's redirect would, returning the authorization request. */
async function startSilent(next = "/d/abc") {
  const res = await startRoute.GET(new Request(`${PUBLIC_URL}/api/auth/sso/start?prompt=none&next=${encodeURIComponent(next)}`));
  expect(res.status).toBe(302);
  const url = new URL(where(res)!);
  lastNonce = url.searchParams.get("nonce")!;
  return url;
}
const callback = (params: Record<string, string>) =>
  callbackRoute.GET(new Request(`${PUBLIC_URL}/api/auth/sso/callback?${new URLSearchParams(params)}`));

describe("start route: prompt and IdP hint", () => {
  it("prompt=none reaches AIN SSO and is remembered with the pending request", async () => {
    const auth = await startSilent("/s/tok");
    expect(auth.origin + auth.pathname).toBe(`${ISSUER}/oidc/auth`);
    expect(auth.searchParams.get("prompt")).toBe("none");
    const row = db.prepare("SELECT prompt, next_path FROM sso_login_requests WHERE id = ?").get(jar.get("aindrive_sso_tx")!) as { prompt: string; next_path: string };
    expect(row).toEqual({ prompt: "none", next_path: "/s/tok" });
  });

  it("prompt=create (sign up) and ain_idp=google are passed through; anything else is dropped", async () => {
    const url = async (q: string) => new URL(where(await startRoute.GET(new Request(`${PUBLIC_URL}/api/auth/sso/start?${q}`)))!);
    const create = await url("prompt=create&next=%2F");
    expect(create.searchParams.get("prompt")).toBe("create");
    expect(create.searchParams.get("ain_idp")).toBeNull();
    const google = await url("ain_idp=google&next=%2F");
    expect(google.searchParams.get("ain_idp")).toBe("google");
    expect(google.searchParams.get("prompt")).toBeNull();
    const junk = await url("prompt=login%20consent&ain_idp=evil.example&next=%2F");
    expect(junk.searchParams.get("prompt")).toBeNull();
    expect(junk.searchParams.get("ain_idp")).toBeNull();
    const plain = await url("next=%2F");
    expect(plain.searchParams.get("prompt")).toBeNull(); // "Continue with AIN" unchanged
  });

  it("a silent check whose issuer is unreachable returns to the page (no error page)", async () => {
    vi.stubGlobal("fetch", (async () => new Response("down", { status: 503 })) as typeof fetch);
    try {
      const res = await startRoute.GET(new Request(`${PUBLIC_URL}/api/auth/sso/start?prompt=none&next=%2Fd%2Fabc`));
      expect(res.status).toBe(302);
      expect(where(res)).toBe("/d/abc");
      const button = await startRoute.GET(new Request(`${PUBLIC_URL}/api/auth/sso/start?next=%2Fd%2Fabc`));
      expect(where(button)).toBe("/login?sso_error=sso_unavailable"); // the button still explains
    } finally {
      vi.stubGlobal("fetch", fake.impl);
    }
  });
});

describe("callback of a silent check", () => {
  it.each(["login_required", "interaction_required", "consent_required", "account_selection_required"])(
    "%s → back to the page as an anonymous visitor, no error",
    async (error) => {
      const auth = await startSilent("/d/abc?path=x");
      const res = await callback({ error, state: auth.searchParams.get("state")!, iss: ISSUER });
      expect(res.status).toBe(303);
      expect(where(res)).toBe("/d/abc?path=x");
      expect(jar.get("aindrive_session")).toBeUndefined();
      expect(jar.get("aindrive_sso_link")).toBeUndefined();
      expect(jar.get("aindrive_sso_tx")).toBeUndefined(); // one-time
    },
  );

  it("access_denied (not assigned to aindrive) is an anonymous visit too, and not logged as a failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const auth = await startSilent("/s/tok");
      const res = await callback({ error: "access_denied", state: auth.searchParams.get("state")!, iss: ISSUER });
      expect(where(res)).toBe("/s/tok");
      expect(warn).not.toHaveBeenCalled();
      const other = await startSilent("/s/tok2");
      expect(where(await callback({ error: "server_error", state: other.searchParams.get("state")!, iss: ISSUER }))).toBe("/s/tok2");
      expect(warn).toHaveBeenCalledOnce(); // unexpected answers are logged, still anonymous
    } finally {
      warn.mockRestore();
    }
  });

  it("a sign-up (prompt=create) that ends in an existing AIN account is an ordinary sign-in", async () => {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES ('u_existing', 'existing@example.com', 'E', 'x')").run();
    db.prepare("INSERT INTO sso_identities (issuer, subject, user_id, link_method, linked_at, last_login_at) VALUES (?, 'acc_existing', 'u_existing', 'jit', ?, ?)").run(ISSUER, Date.now(), Date.now());
    idTokenFor = claims("acc_existing");
    const res = await startRoute.GET(new Request(`${PUBLIC_URL}/api/auth/sso/start?prompt=create&next=%2Fd%2Fnew`));
    const auth = new URL(where(res)!);
    lastNonce = auth.searchParams.get("nonce")!;
    expect(where(await callback({ code: "c", state: auth.searchParams.get("state")!, iss: ISSUER }))).toBe("/d/new");
    expect((await session.getUser())?.id).toBe("u_existing");
  });

  it("a login_required answer without this browser's pending request still shows no error", async () => {
    const res = await callback({ error: "login_required", state: "whatever", iss: ISSUER });
    expect(where(res)).toBe("/");
  });

  it("the button flow keeps its error page", async () => {
    const res = await startRoute.GET(new Request(`${PUBLIC_URL}/api/auth/sso/start?next=%2Fd%2Fabc`));
    const state = new URL(where(res)!).searchParams.get("state")!;
    expect(where(await callback({ error: "access_denied", state, iss: ISSUER }))).toBe("/login?sso_error=access_denied");
  });

  it("success signs in exactly like the button: a linked account lands on the page", async () => {
    // First time: not linked → the connect-or-create page (with "Not now").
    idTokenFor = claims("acc_silent");
    let auth = await startSilent("/d/abc");
    expect(where(await callback({ code: "c1", state: auth.searchParams.get("state")!, iss: ISSUER }))).toBe("/sso/link");
    const create = await linkRoute.POST(new Request(`${PUBLIC_URL}/api/auth/sso/link`, { method: "POST", headers: { "content-type": "application/json", origin: PUBLIC_URL }, body: JSON.stringify({ method: "new" }) }));
    expect(await create.json()).toEqual({ redirect: "/d/abc" });
    // Later, in a browser without an aindrive session: straight back, signed in.
    jar.clear();
    auth = await startSilent("/d/xyz");
    const res = await callback({ code: "c2", state: auth.searchParams.get("state")!, iss: ISSUER });
    expect(where(res)).toBe("/d/xyz");
    expect((await session.getUser())?.id).toBe(store.identityFor(ISSUER, "acc_silent")!.user_id);
  });
});

describe("placeholders made by the provisioning adapter", () => {
  const placeholder = (sub: string, userId: string) => {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run(userId, `${sub}@sso.aindrive.local`, "P", "x");
    db.prepare("INSERT INTO sso_identities (issuer, subject, user_id, link_method, linked_at) VALUES (?,?,?,?,?)").run(ISSUER, sub, userId, "provisioned", Date.now());
  };

  it("a never-used placeholder does not swallow the first sign-in: the person may connect the legacy account", async () => {
    placeholder("acc_ph", "u_placeholder");
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("u_legacy_ph", "legacy-ph@example.com", "L", "x");
    idTokenFor = claims("acc_ph");
    const auth = await startSilent("/d/abc");
    expect(where(await callback({ code: "c", state: auth.searchParams.get("state")!, iss: ISSUER }))).toBe("/sso/link");
    jar.set("aindrive_session", await session.sign("u_legacy_ph"));
    const res = await linkRoute.POST(new Request(`${PUBLIC_URL}/api/auth/sso/link`, { method: "POST", headers: { "content-type": "application/json", origin: PUBLIC_URL }, body: JSON.stringify({ method: "legacy_session" }) }));
    expect(res.status).toBe(200);
    expect(store.identityFor(ISSUER, "acc_ph")).toMatchObject({ user_id: "u_legacy_ph", link_method: "app_proof:legacy_session" });
    expect(db.prepare("SELECT id FROM users WHERE id = 'u_placeholder'").get()).toBeTruthy(); // never deleted
  });

  it("'create' keeps the placeholder as the account; once used it is no longer replaceable", async () => {
    placeholder("acc_ph2", "u_placeholder2");
    idTokenFor = claims("acc_ph2");
    const auth = await startSilent("/d/abc");
    expect(where(await callback({ code: "c", state: auth.searchParams.get("state")!, iss: ISSUER }))).toBe("/sso/link");
    await linkRoute.POST(new Request(`${PUBLIC_URL}/api/auth/sso/link`, { method: "POST", headers: { "content-type": "application/json", origin: PUBLIC_URL }, body: JSON.stringify({ method: "new" }) }));
    const ident = store.identityFor(ISSUER, "acc_ph2")!;
    expect(ident.user_id).toBe("u_placeholder2");
    expect(store.isPlaceholderIdentity(ident)).toBe(false);
    jar.clear();
    const again = await startSilent("/d/q");
    expect(where(await callback({ code: "c", state: again.searchParams.get("state")!, iss: ISSUER }))).toBe("/d/q");
  });
});

describe("sign-out and the loop guard", () => {
  const logout = (q = "") => logoutRoute.POST(new Request(`${PUBLIC_URL}/api/auth/logout${q}`, { method: "POST" }));

  it("signing out through AIN (RP-initiated logout) sets the guard: AIN's 'Stay signed in' still returns here", async () => {
    idTokenFor = claims("acc_silent");
    const auth = await startSilent("/d/abc");
    await callback({ code: "c", state: auth.searchParams.get("state")!, iss: ISSUER });
    jar.delete("ain_sso_checked"); // expired while signed in
    oidc.clearDiscoveryCache(); // not cached (e.g. after a restart): discovered for the logout
    const res = await logout();
    const end = new URL(where(res)!);
    expect(end.origin + end.pathname).toBe(`${ISSUER}/oidc/session/end`);
    expect(end.searchParams.get("post_logout_redirect_uri")).toBe(`${PUBLIC_URL}/`);
    expect(jar.get("aindrive_session")).toBeUndefined();
    expect(jar.get("ain_sso_checked")).toBe("1");
    // AIN sends the browser to "/" whichever button the person chose there; with
    // "Stay signed in" the AIN session is alive, so a silent check would sign it back in.
    const landing = await middleware(page("/", { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") }));
    expect(isRedirect(landing)).toBe(false);
  });

  it("signing out of a legacy session keeps a live AIN session from signing the browser straight back in", async () => {
    jar.set("aindrive_session", await session.sign("u_legacy_ph"));
    const res = await logout();
    expect(where(res)).toBe("/");
    expect(jar.get("ain_sso_checked")).toBe("1");
    expect((await middleware(page("/", { cookie: "ain_sso_checked=1" }))).status).toBe(200);
  });

  it("with SSO off, sign-out sets nothing new", async () => {
    for (const k of Object.keys(SSO_ENV)) delete process.env[k];
    jar.set("aindrive_session", await session.sign("u_legacy_ph"));
    await logout();
    expect(jar.get("ain_sso_checked")).toBeUndefined();
  });
});

describe("a session cookie that died server-side does not switch the silent check off", () => {
  const backchannel = async (c: Record<string, unknown>) =>
    handleBackchannelLogout(new Request(`${PUBLIC_URL}/api/auth/sso/backchannel-logout`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ logout_token: await issuer.logoutToken(c) }).toString(),
    }), { keys: issuer.keys });

  /** Signed in with AIN, then signed out of AIN from another app: the next day this browser only has the dead cookie. */
  async function deadCookie(sub: string) {
    idTokenFor = claims(sub);
    const auth = await startSilent("/d/abc");
    expect(where(await callback({ code: "c", state: auth.searchParams.get("state")!, iss: ISSUER }))).toBe("/sso/link");
    expect((await linkRoute.POST(new Request(`${PUBLIC_URL}/api/auth/sso/link`, { method: "POST", headers: { "content-type": "application/json", origin: PUBLIC_URL }, body: JSON.stringify({ method: "new" }) }))).status).toBe(200);
    const dead = jar.get("aindrive_session")!;
    expect((await backchannel({ sid: `sid-${sub}` })).status).toBe(200);
    expect(await session.verify(dead)).toBeNull();
    jar.clear();
    jar.set("aindrive_session", dead);
    pageHeaders = new Headers(NAV);
    return dead;
  }

  it("the page repeats the check; the start route drops the dead cookie and sets the guard; AIN signs the browser back in", async () => {
    const dead = await deadCookie("acc_dead");
    // The middleware can't tell (Edge, no database): a cookie is present, so the page renders.
    expect((await middleware(page("/d/abc?path=docs", { cookie: `aindrive_session=${dead}` }))).status).toBe(200);
    // The page finds no user and asks: the middleware's decision, as if there were no cookie.
    const check = await staleSessionCheck("/d/abc", "?path=docs");
    expect(check).toBe("/api/auth/sso/start?prompt=none&next=%2Fd%2Fabc%3Fpath%3Ddocs");
    const res = await startRoute.GET(new Request(`${PUBLIC_URL}${check}`));
    expect(new URL(where(res)!).searchParams.get("prompt")).toBe("none");
    expect(jar.get("aindrive_session")).toBeUndefined(); // dropped
    expect(jar.get("ain_sso_checked")).toBe("1"); // the loop guard
    // The person signed in to AIN again elsewhere: back, signed in.
    lastNonce = new URL(where(res)!).searchParams.get("nonce")!;
    const back = await callback({ code: "c2", state: new URL(where(res)!).searchParams.get("state")!, iss: ISSUER });
    expect(where(back)).toBe("/d/abc?path=docs");
    expect((await session.getUser())?.id).toBe(store.identityFor(ISSUER, "acc_dead")!.user_id);
  });

  it("no repeat with the guard, a live or no cookie, for RSC/prefetch/bots, or with the check off", async () => {
    await deadCookie("acc_dead2");
    expect(await staleSessionCheck("/")).toBe("/api/auth/sso/start?prompt=none&next=%2F");
    jar.set("ain_sso_checked", "1");
    expect(await staleSessionCheck("/")).toBeNull();
    jar.delete("ain_sso_checked");
    const skipped: Record<string, string>[] = [{ rsc: "1" }, { "sec-purpose": "prefetch" }, { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" }, { "sec-fetch-dest": "iframe" }];
    for (const h of skipped) {
      pageHeaders = new Headers({ ...NAV, ...h });
      expect(await staleSessionCheck("/")).toBeNull();
    }
    pageHeaders = new Headers(NAV);
    process.env.AINDRIVE_SSO_SILENT = "false";
    expect(await staleSessionCheck("/")).toBeNull();
    delete process.env.AINDRIVE_SSO_SILENT;
    jar.delete("aindrive_session");
    expect(await staleSessionCheck("/")).toBeNull(); // no cookie: the middleware already decided
  });

  it("the start route keeps a live cookie; /api/auth/me drops a dead one", async () => {
    const dead = await deadCookie("acc_dead3");
    expect((await meRoute.GET()).status).toBe(401);
    expect(jar.get("aindrive_session")).toBeUndefined();
    const live = await session.sign(store.identityFor(ISSUER, "acc_dead3")!.user_id);
    jar.set("aindrive_session", live);
    await startRoute.GET(new Request(`${PUBLIC_URL}/api/auth/sso/start?next=%2F`));
    expect(jar.get("aindrive_session")).toBe(live);
    expect(jar.get("ain_sso_checked")).toBeUndefined(); // the button is not a silent check
    expect(dead).not.toBe(live);
  });

  it("the landing page and the drive pages ask before rendering anonymous", () => {
    const src = (f: string) => readFileSync(join(__dirname, "../..", f), "utf8");
    for (const [file, call] of [
      ["app/page.tsx", 'staleSessionCheck("/")'],
      ["app/d/[driveId]/page.tsx", "staleSessionCheck(`/d/${driveId}`"],
      ["app/d/[driveId]/manage/page.tsx", "staleSessionCheck(`/d/${driveId}/manage`)"],
    ]) {
      expect(src(file)).toContain('import { staleSessionCheck } from "@/lib/sso/stale-session";');
      expect(src(file)).toContain(call);
    }
  });
});
