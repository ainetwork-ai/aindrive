import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { env } from "./env";
import { db } from "./db";
import { cookieOptions } from "./cookie-config";
import { disconnectUserSockets, endAllUserSessions, endSsoSession, getSsoSession, isAccountBlocked, liveSessionUserId, sessionEpoch } from "./sso/store.js";

const COOKIE = "aindrive_session";
const enc = new TextEncoder();

function key() { return enc.encode(env.sessionSecret); }

/**
 * The session JWT: `{sub}` (+ `ep` once the account's session epoch was
 * bumped, + `ses` for an AIN SSO sign-in's server-side session row). Tokens
 * minted before AIN SSO existed carry only `{sub}` and stay valid as before.
 */
export async function sign(userId: string, opts: { ssoSessionId?: string } = {}) {
  // Last line of defence: every sign-in path checks this first and answers 403.
  if (isAccountBlocked(userId)) throw new Error("account_blocked");
  const claims: Record<string, unknown> = { sub: userId };
  const ep = sessionEpoch(userId);
  if (ep > 0) claims.ep = ep;
  if (opts.ssoSessionId) claims.ses = opts.ssoSessionId;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(key());
}

/**
 * Signature + expiry, then the server-side gate (lib/sso/store.js
 * liveSessionUserId): a revoked epoch, an ended SSO session or an account
 * suspended through AIN SSO no longer verifies — for the cookie, the bearer
 * uses (/mcp, A2A, AG-UI, file bytes) and the CLI/mobile pairing token alike.
 */
export async function verify(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, key());
    return liveSessionUserId(payload);
  } catch { return null; }
}

export type SessionUser = { id: string; email: string; name: string };

export async function getUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const userId = await verify(token);
  if (!userId) return null;
  const row = db
    .prepare("SELECT id, email, name FROM users WHERE id = ?")
    .get(userId) as SessionUser | undefined;
  return row ?? null;
}

/**
 * The session user of a request that may carry `Authorization: Bearer <session
 * JWT>` (the token sign() makes — the same one /mcp accepts) instead of the
 * cookie: server-side hosts (ainmem's asset proxy) fetch file bytes this way.
 * A bearer that is present but not a valid session JWT is "invalid" — never
 * silently replaced by the cookie. No bearer → the cookie, as getUser().
 */
export async function getRequestUser(req: Request): Promise<SessionUser | null | "invalid"> {
  const m = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  if (!m) return getUser();
  const userId = await verify(m[1].trim());
  if (!userId) return "invalid";
  const row = db
    .prepare("SELECT id, email, name FROM users WHERE id = ?")
    .get(userId) as SessionUser | undefined;
  return row ?? "invalid";
}

export async function setCookie(userId: string, opts: { ssoSessionId?: string } = {}) {
  const token = await sign(userId, opts);
  (await cookies()).set(COOKIE, token, cookieOptions());
}

export async function clearCookie() {
  (await cookies()).delete(COOKIE);
}

/**
 * Deletes a session cookie that no longer verifies (its session ended through
 * AIN SSO, the account was suspended, the epoch moved on, it expired): kept,
 * it would make the middleware skip the silent check (lib/sso/stale-session.ts).
 * Route handlers only. True if it did.
 */
export async function dropDeadSessionCookie(): Promise<boolean> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token || (await verify(token))) return false;
  jar.delete(COOKIE);
  return true;
}

/**
 * The AIN SSO session behind the current cookie, if it is one and still live
 * (null for legacy sessions). Its `org_id` scopes credentials created in it.
 */
export async function currentSsoSession() {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key());
    if (typeof payload.ses !== "string" || !liveSessionUserId(payload)) return null;
    const row = getSsoSession(payload.ses);
    return row && row.ended_at === null ? row : null;
  } catch { return null; }
}

/** Sign-out: ends the AIN SSO session row behind the cookie (if any) and returns it. */
export async function endCurrentSsoSession() {
  const s = await currentSsoSession();
  if (s) endSsoSession(s.id, "logout");
  return s;
}

/**
 * "Sign out everywhere": ends EVERY session of the signed-in account — this
 * browser, other browsers, and the sign-in a CLI / Mac app / phone keeps from
 * pairing (`~/.aindrive/credentials.json`, a 30-day session JWT) — by bumping
 * the account's session epoch (lib/sso/store.js endAllUserSessions), and closes
 * the account's open collaboration sockets. What a lost device could still do
 * with its sign-in (list drives, read other devices' files, mint a drive's
 * credentials again with `aindrive rotate-token`) stops here; the drive a
 * device serves is removed separately (rotate / delete). Returns the user id,
 * or null when no one is signed in.
 */
export async function endAllSessionsOfCurrentUser(): Promise<string | null> {
  const user = await getUser();
  if (!user) return null;
  endAllUserSessions(user.id, "signed_out_everywhere");
  disconnectUserSockets({ userId: user.id });
  return user.id;
}
