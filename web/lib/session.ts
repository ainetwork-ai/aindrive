import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { env } from "./env";
import { db } from "./db";
import { cookieOptions } from "./cookie-config";

const COOKIE = "aindrive_session";
const enc = new TextEncoder();

function key() { return enc.encode(env.sessionSecret); }

export async function sign(userId: string) {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(key());
}

export async function verify(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, key());
    return (payload.sub as string) || null;
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

export async function setCookie(userId: string) {
  const token = await sign(userId);
  (await cookies()).set(COOKIE, token, cookieOptions());
}

export async function clearCookie() {
  (await cookies()).delete(COOKIE);
}
