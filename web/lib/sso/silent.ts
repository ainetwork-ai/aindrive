/**
 * Silent AIN SSO ("automatic sign-in", lib/sso/README.md): a browser that
 * opens an aindrive page without an aindrive session is sent once to
 * /api/auth/sso/start with `prompt=none`. With a live AIN session it comes
 * back signed in (the "Continue with AIN" code path); without one AIN SSO
 * answers `login_required` and the callback returns it to the page as an
 * anonymous visitor. A cookie (`ain_sso_checked`, 30 min) set BEFORE the
 * redirect keeps it to one check per browser per 30 minutes.
 *
 * Runs in middleware.ts (Edge runtime): no Node APIs, no database, no
 * lib/env import. Everything here decides from the request alone.
 */
import { safeNextPath } from "../safe-next";

export const SSO_CHECKED_COOKIE = "ain_sso_checked";
export const SSO_CHECKED_MAX_AGE = 30 * 60;
/**
 * The guard's value after a sign-out (the logout route; any other setter
 * writes "1"). The silent check skips the browser whatever the value; this one
 * also keeps /oauth/authorize from sending a trusted client's visitor straight
 * to AIN SSO's sign-in, which a live AIN session would complete without a page
 * (lib/oauth-authorize.ts). A later check never downgrades it to "1".
 */
export const SSO_SIGNED_OUT = "signed_out";
/** Mirrors lib/session.ts COOKIE. */
export const SESSION_COOKIE = "aindrive_session";

/**
 * Error codes an authorization request with prompt=none gets when the person
 * would have to interact (OIDC Core §3.1.2.6). Never shown as an error.
 */
export const SILENT_ERRORS: ReadonlySet<string> = new Set([
  "login_required",
  "interaction_required",
  "consent_required",
  "account_selection_required",
]);

/**
 * Normal answers to a silent check, not logged: the above, and access_denied
 * (AIN SSO's answer for an account that aindrive is not assigned to).
 * Every failure of a silent check is an anonymous visit; others are logged.
 */
export const SILENT_QUIET_ERRORS: ReadonlySet<string> = new Set([...SILENT_ERRORS, "access_denied"]);

type Env = Record<string, string | undefined>;
const val = (env: Env, k: string) => (env[k] ?? "").trim();

/**
 * Same rule as config.ts ssoLoginConfig() (issuer + client id + secret +
 * ENABLED=true, issuer https or a loopback/non-production http), plus
 * AINDRIVE_SSO_SILENT=false as an off switch for the automatic check alone.
 * config.ts can't be imported here: lib/env pulls in node:fs.
 */
export function silentSsoEnabled(env: Env = process.env): boolean {
  if (/^(false|0|off)$/i.test(val(env, "AINDRIVE_SSO_SILENT"))) return false;
  if (!/^(true|1)$/i.test(val(env, "AINDRIVE_SSO_ENABLED"))) return false;
  if (!val(env, "AINDRIVE_SSO_CLIENT_ID") || !val(env, "AINDRIVE_SSO_CLIENT_SECRET")) return false;
  let u: URL;
  try { u = new URL(val(env, "AINDRIVE_SSO_ISSUER")); } catch { return false; }
  if (u.search || u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol !== "http:") return false;
  return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || env.NODE_ENV !== "production";
}

/**
 * Not pages, or pages that must keep working exactly as before: API and
 * framework routes, the sign-in/sign-up/recovery pages, the SSO link page,
 * OAuth consent and CLI pairing (their own flows), MCP/A2A/AG-UI endpoints,
 * well-known documents and downloads.
 */
const EXCLUDED = [
  "/api", "/_next", "/login", "/signup", "/forgot-password", "/reset-password", "/sso",
  "/oauth", "/cli-login", "/mcp", "/a2a", "/agui", "/ainui", "/.well-known", "/download",
  "/_dev", "/%5Fdev", "/%5fdev",
];

/** Crawlers, link unfurlers, headless browsers and HTTP libraries. */
const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|facebookcatalog|embedly|preview|whatsapp|telegram|slack|discord|linkedin|pinterest|vkshare|quora|outbrain|yandex|baidu|duckduck|lighthouse|pagespeed|headless|phantomjs|puppeteer|playwright|selenium|curl\/|wget|python|httpclient|okhttp|go-http|node-fetch|axios|java\//i;

export function isExcludedPath(pathname: string): boolean {
  if (EXCLUDED.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return true;
  // Static files (favicon.ico, robots.txt, /monaco/…/*.js, …): a dot in the last segment.
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return last.includes(".");
}

export type SilentRequest = {
  method: string;
  pathname: string;
  search: string;
  headers: Pick<Headers, "get" | "has">;
  cookies: { has(name: string): boolean };
};

/** Why a request is not silently checked (null = check it). Exported for tests and logs. */
export function silentSkipReason(req: SilentRequest, env: Env = process.env): string | null {
  if (req.method !== "GET" && req.method !== "HEAD") return "method";
  if (!silentSsoEnabled(env)) return "disabled";
  if (isExcludedPath(req.pathname)) return "path";
  if (req.cookies.has(SESSION_COOKIE)) return "session";
  if (req.cookies.has(SSO_CHECKED_COOKIE)) return "checked";
  const h = req.headers;
  // Next.js client navigations and prefetches (RSC payloads), browser prefetch/prerender.
  if (h.has("rsc") || h.has("next-router-prefetch") || h.has("next-router-state-tree") || h.has("x-middleware-prefetch")) return "rsc";
  if (/[?&]_rsc=/.test(req.search)) return "rsc";
  const purpose = `${h.get("sec-purpose") ?? ""} ${h.get("purpose") ?? ""} ${h.get("x-purpose") ?? ""} ${h.get("x-moz") ?? ""}`.toLowerCase();
  if (purpose.includes("prefetch") || purpose.includes("prerender") || purpose.includes("preview")) return "prefetch";
  // Only a top-level document navigation (not fetch/XHR, iframes, images, …).
  const mode = h.get("sec-fetch-mode");
  if (mode && mode !== "navigate") return "not_navigation";
  const dest = h.get("sec-fetch-dest");
  if (dest && dest !== "document") return "not_navigation";
  if (!(h.get("accept") ?? "").toLowerCase().includes("text/html")) return "not_html";
  const ua = h.get("user-agent") ?? "";
  if (!/Mozilla\/\d/.test(ua) || BOT_UA.test(ua)) return "not_browser";
  return null;
}

/**
 * The same-origin start path for a silent check of this request, or null.
 * `next` is the requested path + query, validated like every `?next=`.
 */
export function silentSsoStartPath(req: SilentRequest, env: Env = process.env): string | null {
  if (silentSkipReason(req, env)) return null;
  const next = safeNextPath(`${req.pathname}${req.search}`);
  return `/api/auth/sso/start?prompt=none&next=${encodeURIComponent(next)}`;
}

/** Same rule as lib/cookie-config: Secure follows the public URL's scheme. */
export function checkedCookieSecure(env: Env = process.env): boolean {
  return val(env, "AINDRIVE_PUBLIC_URL").startsWith("https://");
}
