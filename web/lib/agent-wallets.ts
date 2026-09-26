/**
 * Agent wallets — a key this server keeps for an account so an agent acting
 * as that account can PAY over x402 (`x402_wallet` / `x402_sign` skills).
 *
 * This is deliberately NOT the account's identity wallet. Login (SIWE) and
 * payment are separate proofs (docs/PERMISSIONS.md), and identity wallets are
 * self-custodial: aindrive never holds those keys. An agent wallet is the
 * opposite — a small custodial "pocket-money" wallet, made on first use, whose
 * whole point is that software can sign with it without a person present.
 * Fund it with what an agent may spend, nothing more.
 *
 * Off unless AINDRIVE_AGENT_WALLETS=1: the pay skills are not even listed
 * then, so a client that looks for them (ainmem's gift settlement) sees the
 * capability appear the day an operator switches it on.
 *
 * Keys rest AES-256-GCM under the session secret (table agent_wallets); a
 * changed secret means new wallets, never plaintext.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { getAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { db } from "./db";
import { env } from "./env";

export function agentWalletsEnabled(): boolean {
  return process.env.AINDRIVE_AGENT_WALLETS === "1";
}

function key(): Buffer {
  const secret = env.sessionSecret;
  if (!secret) throw new Error("AINDRIVE_SESSION_SECRET is required for agent wallets");
  return createHash("sha256").update(`agent-wallet:${secret}`).digest();
}

function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}

function open(sealed: string): string | null {
  try {
    const [iv, tag, body] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
    const d = createDecipheriv("aes-256-gcm", key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

type Row = { address: string; key_enc: string };

/** The account's agent wallet, made on first use. */
export function agentWalletOf(accountId: string): { address: Hex; key: Hex } {
  const row = db.prepare("SELECT address, key_enc FROM agent_wallets WHERE account_id = ?").get(accountId) as Row | undefined;
  if (row) {
    const k = open(row.key_enc);
    if (k) return { address: getAddress(row.address), key: k as Hex };
    // secret changed: the old key is unrecoverable — replace the wallet
    db.prepare("DELETE FROM agent_wallets WHERE account_id = ?").run(accountId);
  }
  const k = generatePrivateKey();
  const address = privateKeyToAccount(k).address;
  db.prepare("INSERT INTO agent_wallets (id, account_id, address, key_enc) VALUES (?,?,?,?)")
    .run(nanoid(10), accountId, address.toLowerCase(), seal(k));
  return { address, key: k };
}

/** Whose agent wallet `address` is, or null. */
export function accountOfAgentWallet(address: string): string | null {
  const row = db.prepare("SELECT account_id FROM agent_wallets WHERE address = ?").get(address.toLowerCase()) as { account_id: string } | undefined;
  return row?.account_id ?? null;
}
