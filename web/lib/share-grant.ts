import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { env } from "./env";
import { cookieOptions } from "./cookie-config";

/**
 * Free-share grant cookie.
 *
 * A *free* share (price_usdc IS NULL) grants access to anyone holding the
 * link, but the permission system keys on wallet/session — a link-only
 * visitor has neither. Rather than write an anonymous folder_access row
 * (which would pollute the owner's allowlist and be hard to revoke), we
 * give the visitor a signed cookie listing the free-share tokens they have
 * opened. resolveAccess() reads this cookie as a third fallback and looks
 * the token up in `shares` — granting access ONLY when the share is
 * actually free, so this path can never bypass a paywall.
 *
 * The cookie is server-signed (HS256), so a visitor cannot forge tokens;
 * and share tokens are 24-char nanoids, so they cannot be guessed. The
 * cookie therefore proves "I was given this link," which is exactly the
 * access condition for a free share.
 */
const COOKIE = "aindrive_share";
const enc = new TextEncoder();
const MAX_TOKENS = 50; // cap cookie growth; oldest entries fall off

function key() {
  return enc.encode(env.sessionSecret);
}

export async function readShareGrants(): Promise<string[]> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return [];
  try {
    const { payload } = await jwtVerify(raw, key());
    const tokens = payload.tokens;
    return Array.isArray(tokens) ? (tokens as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * Add a free-share token to the visitor's grant cookie (idempotent).
 * Reads the current cookie, appends if absent, re-signs. Keeps the newest
 * MAX_TOKENS entries.
 */
export async function addShareGrant(token: string): Promise<void> {
  const existing = await readShareGrants();
  if (existing.includes(token)) return;
  const next = [...existing, token].slice(-MAX_TOKENS);
  const jwt = await new SignJWT({ tokens: next })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(key());
  (await cookies()).set(COOKIE, jwt, cookieOptions());
}
