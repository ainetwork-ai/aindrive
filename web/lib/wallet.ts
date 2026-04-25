import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { SiweMessage } from "siwe";
import { env } from "./env";

const COOKIE = "aindrive_wallet";
const enc = new TextEncoder();

function key() { return enc.encode(env.sessionSecret); }

export async function signWallet(address: string) {
  return new SignJWT({ addr: address.toLowerCase() })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(key());
}

export async function verifyWalletToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, key());
    return ((payload.addr as string) || null)?.toLowerCase() ?? null;
  } catch { return null; }
}

export async function getWallet(): Promise<string | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  return verifyWalletToken(token);
}

export async function setWalletCookie(address: string) {
  const token = await signWallet(address);
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.publicUrl.startsWith("https://"),
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearWalletCookie() {
  (await cookies()).delete(COOKIE);
}

/**
 * Per-process in-memory nonce cache (keyed by IP).
 *   ip → Set<{ nonce, expiresAt }>
 *
 * In a multi-process deployment this would need Redis or DB; for our
 * single-process local server this is enough.
 */
declare global {
  // eslint-disable-next-line no-var
  var __aindrive_nonces: Map<string, { value: string; expiresAt: number }[]> | undefined;
}
const nonces = globalThis.__aindrive_nonces ?? new Map<string, { value: string; expiresAt: number }[]>();
if (!globalThis.__aindrive_nonces) globalThis.__aindrive_nonces = nonces;

const NONCE_TTL_MS = 5 * 60_000;

export function issueNonce(ip: string): { nonce: string; expiresAt: number } {
  const value = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const expiresAt = Date.now() + NONCE_TTL_MS;
  const entry = nonces.get(ip) || [];
  // GC expired
  const fresh = entry.filter((n) => n.expiresAt > Date.now());
  fresh.push({ value, expiresAt });
  nonces.set(ip, fresh);
  return { nonce: value, expiresAt };
}

export function consumeNonce(ip: string, value: string): boolean {
  const entry = nonces.get(ip);
  if (!entry) return false;
  const idx = entry.findIndex((n) => n.value === value && n.expiresAt > Date.now());
  if (idx < 0) return false;
  entry.splice(idx, 1);
  return true;
}

export function challengeMessage(nonce: string, address: string): string {
  const url = new URL(env.publicUrl);
  const msg = new SiweMessage({
    domain: url.host,
    address,
    statement: "aindrive wants you to sign in with your wallet.",
    uri: env.publicUrl,
    version: "1",
    chainId: 1,
    nonce,
  });
  return msg.prepareMessage();
}
