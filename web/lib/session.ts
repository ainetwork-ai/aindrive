import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { env } from "./env";
import { db } from "./db";

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

export async function setCookie(userId: string) {
  const token = await sign(userId);
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && !!process.env.AINDRIVE_PUBLIC_URL?.startsWith("https://"),
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearCookie() {
  (await cookies()).delete(COOKIE);
}
