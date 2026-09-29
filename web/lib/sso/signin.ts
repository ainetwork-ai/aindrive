/**
 * The last step of an AIN SSO sign-in (callback or "connect / create"): a
 * server-side sso_sessions row keyed by the OIDC sid, and the usual session
 * cookie carrying that row's id. Plus the two short-lived cookies of the flow.
 */
import { cookies } from "next/headers";
import { env } from "../env";
import { setCookie } from "../session";
import { adoptSignInPayoutWallet } from "../drives";
import { createSsoSession, identityFor } from "./store.js";
import { signInLandingPath } from "../orgs.js";
import { SSO_CHECKED_COOKIE, SSO_CHECKED_MAX_AGE, SSO_SIGNED_OUT } from "./silent";

/** Pending authorization request (state, nonce, PKCE) — only the callback reads it. */
export const TX_COOKIE = "aindrive_sso_tx";
const TX_PATH = "/api/auth/sso";
/** A verified AIN login waiting for "connect your account / create one". */
export const LINK_COOKIE = "aindrive_sso_link";

function secure(): boolean {
  return env.publicUrl.startsWith("https://"); // same rule as lib/cookie-config
}

export async function setTxCookie(id: string) {
  (await cookies()).set(TX_COOKIE, id, { httpOnly: true, sameSite: "lax", secure: secure(), path: TX_PATH, maxAge: 600 });
}
export async function readTxCookie(): Promise<string | null> {
  return (await cookies()).get(TX_COOKIE)?.value ?? null;
}
export async function clearTxCookie() {
  (await cookies()).set(TX_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: secure(), path: TX_PATH, maxAge: 0 });
}

export async function setLinkCookie(id: string) {
  (await cookies()).set(LINK_COOKIE, id, { httpOnly: true, sameSite: "lax", secure: secure(), path: "/", maxAge: 900 });
}
export async function readLinkCookie(): Promise<string | null> {
  return (await cookies()).get(LINK_COOKIE)?.value ?? null;
}
export async function clearLinkCookie() {
  (await cookies()).set(LINK_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: secure(), path: "/", maxAge: 0 });
}

/**
 * The silent check's loop guard (lib/sso/silent.ts), outside the middleware:
 * set on every sign-out (`signed_out`), so an AIN session this browser still
 * has does not sign it straight back in, and by the start route for every
 * silent check (`checked`, which never overwrites a sign-out's mark: a link
 * to a silent check must not undo the sign-out for /oauth/authorize).
 */
export async function markSilentChecked(reason: "checked" | "signed_out" = "checked") {
  const jar = await cookies();
  if (reason === "checked" && jar.get(SSO_CHECKED_COOKIE)?.value === SSO_SIGNED_OUT) return;
  const value = reason === "signed_out" ? SSO_SIGNED_OUT : "1";
  jar.set(SSO_CHECKED_COOKIE, value, { httpOnly: true, sameSite: "lax", secure: secure(), path: "/", maxAge: SSO_CHECKED_MAX_AGE });
}

/**
 * Starts the session and returns where the browser goes next: `nextPath`,
 * except that the home page becomes the person's organization drive on their
 * first AIN sign-in or while they have no personal drive (lib/orgs.js
 * signInLandingPath), so a company folder is the first thing they see.
 */
export async function beginSsoSession(
  userId: string,
  p: { issuer: string; subject: string; oidcSid: string | null; orgId: string | null; orgIds: string[] },
  nextPath = "/",
): Promise<string> {
  // Read before createSsoSession stamps last_login_at.
  const firstSignIn = !identityFor(p.issuer, p.subject)?.last_login_at;
  const ssoSessionId = createSsoSession({ userId, ...p });
  adoptSignInPayoutWallet(userId);
  await setCookie(userId, { ssoSessionId });
  return signInLandingPath(userId, nextPath, firstSignIn);
}

/** Relative Location, like app/api/auth/logout: resolves against the public URL the browser used. */
export function redirectTo(location: string, status = 303): Response {
  return new Response(null, { status, headers: { Location: location, "Cache-Control": "no-store" } });
}

export function loginError(code: string): Response {
  return redirectTo(`/login?sso_error=${encodeURIComponent(code)}`);
}
