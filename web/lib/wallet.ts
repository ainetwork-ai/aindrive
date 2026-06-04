import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { SiweMessage } from "siwe";
import { nanoid } from "nanoid";
import bcrypt from "bcryptjs";
import { db } from "./db";
import { env } from "./env";
import { cookieOptions } from "./cookie-config";

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
  (await cookies()).set(COOKIE, token, cookieOptions());
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

/** Thrown when a wallet is already linked to a DIFFERENT account. */
export class WalletAlreadyLinkedError extends Error {
  constructor() {
    super("wallet already linked to another account");
    this.name = "WalletAlreadyLinkedError";
  }
}

/**
 * Link `wallet` to `accountId` and reclaim any unattributed payment_receipts
 * for that wallet (account_id IS NULL) by stamping them with `accountId`.
 *
 * The link row is the bridge that lets a paid x402 settle (which only knows a
 * wallet) resolve a durable account. wallet_address is stored lowercased and
 * is UNIQUE — re-linking the SAME wallet to the SAME account is a no-op (we
 * still reclaim receipts); linking to a DIFFERENT account throws.
 *
 * @returns number of receipts reclaimed
 */
export function linkWalletToAccount(accountId: string, wallet: string, verifiedVia: string): number {
  const addr = wallet.toLowerCase();
  const existing = db
    .prepare("SELECT account_id FROM account_wallets WHERE wallet_address = ?")
    .get(addr) as { account_id: string } | undefined;
  if (existing && existing.account_id !== accountId) throw new WalletAlreadyLinkedError();
  if (!existing) {
    db.prepare(
      "INSERT INTO account_wallets (id, account_id, wallet_address, verified_via) VALUES (?, ?, ?, ?)"
    ).run(nanoid(12), accountId, addr, verifiedVia);
  }
  const res = db
    .prepare("UPDATE payment_receipts SET account_id = ? WHERE wallet = ? AND account_id IS NULL")
    .run(accountId, addr);
  return res.changes;
}

/**
 * Resolve the account that a paid-share payer should be credited to:
 *   1. an account already linked to this wallet (account_wallets), else
 *   2. a freshly created wallet-only placeholder account + link.
 *
 * Wallet-only accounts have no real email/password: we mint a deterministic
 * `<wallet>@wallet.aindrive.local` email (satisfies the UNIQUE NOT NULL email
 * column without colliding with human signups) and an unusable random-input
 * bcrypt hash for password_hash (NOT NULL). The user can later claim the
 * account by linking the same wallet through POST /api/wallet/link while
 * logged in to their real account — that path throws on the wallet UNIQUE,
 * so claiming is a future-phase concern; here we only need a stable id.
 *
 * @returns the account id (never null)
 */
export function resolveAccountForWallet(wallet: string): string {
  const addr = wallet.toLowerCase();
  const linked = db
    .prepare("SELECT account_id FROM account_wallets WHERE wallet_address = ?")
    .get(addr) as { account_id: string } | undefined;
  if (linked) return linked.account_id;

  const id = "w_" + nanoid(10);
  const email = `${addr}@wallet.aindrive.local`;
  // Random input → resulting hash can never be reproduced by a login attempt.
  const placeholderHash = bcrypt.hashSync(nanoid(24), 10);
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)"
  ).run(id, email, `wallet:${addr.slice(0, 10)}`, placeholderHash);
  db.prepare(
    "INSERT INTO account_wallets (id, account_id, wallet_address, verified_via) VALUES (?, ?, ?, ?)"
  ).run(nanoid(12), id, addr, "payment");
  return id;
}
