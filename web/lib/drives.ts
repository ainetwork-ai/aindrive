import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { db, drizzleDb } from "./db";
import { drives } from "../drizzle/schema";
import { env } from "./env";
import { generateEd25519Keypair } from "./willow/meadowcap";

export type DriveRow = {
  id: string;
  owner_id: string;
  name: string;
  drive_secret: string;
  agent_token_hash: string;
  last_seen_at: string | null;
  last_hostname: string | null;
  created_at: string;
  namespace_pubkey: Buffer | null;
  namespace_secret: Buffer | null;
  payout_wallet: string | null;
  allowed_tokens: string | null;
};

import { resolvePayoutWallet, type PayoutRow } from "./payout";

/** All path-scoped payout wallets for a drive (incl. the root "" row). */
export function listPayoutWallets(driveId: string): PayoutRow[] {
  return db
    .prepare("SELECT path, wallet FROM drive_payout_wallets WHERE drive_id = ? ORDER BY path")
    .all(driveId) as PayoutRow[];
}

/** Set (or clear, wallet=null) the payout wallet for one path. */
export function setPayoutWallet(driveId: string, path: string, wallet: string | null) {
  if (wallet) {
    db.prepare(
      `INSERT INTO drive_payout_wallets (id, drive_id, path, wallet) VALUES (?, ?, ?, ?)
       ON CONFLICT(drive_id, path) DO UPDATE SET wallet = excluded.wallet`,
    ).run(nanoid(12), driveId, path, wallet);
  } else {
    db.prepare("DELETE FROM drive_payout_wallets WHERE drive_id = ? AND path = ?").run(driveId, path);
  }
}

/** The wallet a sale at `path` pays out to — nearest ancestor's, or null. */
export function payoutWalletFor(driveId: string, path: string): string | null {
  const rows = listPayoutWallets(driveId);
  const found = resolvePayoutWallet(rows, path);
  if (found || rows.length) return found;
  // No payout wallet at all, but the owner signs in with a wallet (linked before sign-in wallets
  // became payout wallets): adopt it as the drive's payout wallet, so selling just works.
  const owner = db.prepare("SELECT owner_id FROM drives WHERE id = ?").get(driveId) as { owner_id: string } | undefined;
  const [signIn] = owner ? loginWallets(owner.owner_id) : [];
  if (!signIn) return null;
  setPayoutWallet(driveId, "", signIn);
  return signIn;
}

/** Back-compat: the drive-level payout wallet is the root ("") path wallet. */
export function setDrivePayoutWallet(driveId: string, payoutWallet: string | null) {
  setPayoutWallet(driveId, "", payoutWallet);
}
export function getDriveRootPayoutWallet(driveId: string): string | null {
  return (db.prepare("SELECT wallet FROM drive_payout_wallets WHERE drive_id = ? AND path = ''").get(driveId) as { wallet: string } | undefined)?.wallet ?? null;
}

/** Update the payment-token policy (JSON of PaymentToken[]). Pass null to reset to default. */
export function setDriveAllowedTokens(driveId: string, allowedTokensJson: string | null) {
  drizzleDb
    .update(drives)
    .set({ allowed_tokens: allowedTokensJson })
    .where(eq(drives.id, driveId))
    .run();
}

export async function createDrive(ownerId: string, name: string) {
  const driveId = nanoid(12);
  const agentToken = nanoid(48);
  const driveSecret = nanoid(48);
  const hash = await bcrypt.hash(agentToken, 10);
  const ns = await generateEd25519Keypair();
  drizzleDb.insert(drives).values({
    id: driveId,
    owner_id: ownerId,
    name,
    agent_token_hash: hash,
    drive_secret: driveSecret,
    namespace_pubkey: Buffer.from(ns.publicKey),
    namespace_secret: Buffer.from(ns.secretKey),
  }).run();
  // New drives pay out to the owner's sign-in wallet from the start (see adoptOwnerPayoutWallet).
  const [signIn] = loginWallets(ownerId);
  if (signIn) setPayoutWallet(driveId, "", signIn);
  const base = env.publicUrl.replace(/\/$/, "");
  return {
    driveId,
    agentToken,
    driveSecret,
    serverUrl: base,
    url: `${base}/d/${driveId}`,
  };
}

export async function rotateAgentToken(driveId: string) {
  const agentToken = nanoid(48);
  const driveSecret = nanoid(48);
  const hash = await bcrypt.hash(agentToken, 10);
  drizzleDb
    .update(drives)
    .set({ agent_token_hash: hash, drive_secret: driveSecret })
    .where(eq(drives.id, driveId))
    .run();
  // A manual rotation supersedes any pending live one.
  db.prepare("UPDATE drives SET rotation_pending = 0 WHERE id = ?").run(driveId);
  return { agentToken, driveSecret };
}

export function getDrive(driveId: string): DriveRow | null {
  const row = drizzleDb
    .select()
    .from(drives)
    .where(eq(drives.id, driveId))
    .get();
  return (row as DriveRow) ?? null;
}

export function getDriveNamespace(driveId: string): { pub: Uint8Array; secret: Uint8Array } | null {
  const row = drizzleDb
    .select({ namespace_pubkey: drives.namespace_pubkey, namespace_secret: drives.namespace_secret })
    .from(drives)
    .where(eq(drives.id, driveId))
    .get();
  if (!row?.namespace_pubkey || !row?.namespace_secret) return null;
  return {
    pub: new Uint8Array(row.namespace_pubkey as Buffer),
    secret: new Uint8Array(row.namespace_secret as Buffer),
  };
}

export function listUserDrives(userId: string): DriveRow[] {
  // GROUP BY + LEFT JOIN: raw SQL is cleaner than drizzle for this query
  return db.prepare(`
    SELECT d.* FROM drives d
    LEFT JOIN drive_members m ON m.drive_id = d.id AND m.user_id = ?
    WHERE d.owner_id = ? OR m.user_id = ?
    GROUP BY d.id
    ORDER BY d.created_at DESC
  `).all(userId, userId, userId) as DriveRow[];
}

/**
 * A wallet the owner signs in with doubles as the default payout wallet: every drive they own that
 * has NO payout wallet yet gets it at the root. Drives with a wallet already are left alone (the
 * owner chose one). Returns how many drives were set.
 */
export function adoptOwnerPayoutWallet(ownerId: string, wallet: string): number {
  const bare = db.prepare(`SELECT d.id FROM drives d WHERE d.owner_id = ?
      AND NOT EXISTS (SELECT 1 FROM drive_payout_wallets p WHERE p.drive_id = d.id)`).all(ownerId) as { id: string }[];
  for (const d of bare) setPayoutWallet(d.id, "", wallet.toLowerCase());
  return bare.length;
}

/** The wallets this account can sign in with (login-enabled links), oldest first. */
export function loginWallets(accountId: string): string[] {
  return (db.prepare("SELECT wallet_address FROM account_wallets WHERE account_id = ? AND login_enabled = 1 ORDER BY linked_at")
    .all(accountId) as { wallet_address: string }[]).map((r) => r.wallet_address);
}

/** At sign-in: the owner's sign-in wallet becomes the payout wallet of their drives that have none. */
export function adoptSignInPayoutWallet(ownerId: string): number {
  const [w] = loginWallets(ownerId);
  return w ? adoptOwnerPayoutWallet(ownerId, w) : 0;
}
