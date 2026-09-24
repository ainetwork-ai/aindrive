/**
 * Tiers — Claude-Code-style "free / pro / max" plans, bought as AIN lifts:
 *
 *   GET /api/x402/lift?scope=tier:pro&priceAin=5   → 30-day Pro tier
 *   GET /api/x402/lift?scope=tier:max&priceAin=50  → 30-day Max tier
 *
 * The lift entries land in `paid_lifts`, keyed by the paying wallet. Two
 * readers, for two different questions:
 *
 *   getUserTier()          the REQUESTER's tier, via the wallet cookie —
 *                          routes scale that caller's rate-limit budget
 *                          with `tierBudget(tier, base)`.
 *   getOwnerStorageCaps(o) the drive OWNER's storage caps, via every wallet
 *                          linked to the owner's account — the per-owner
 *                          file count sums all of the owner's drives, so its
 *                          cap is the owner's, whoever writes: the owner in a
 *                          browser, an editor, a drive PAT or an account
 *                          grant (machine callers send no wallet cookie).
 *
 * No lift means free.
 */

import { db } from "@/lib/db";
import { getWallet } from "@/lib/wallet";
import { getActiveLiftExpiry } from "@/lib/paid-lifts.js";

export type Tier = "free" | "pro" | "max";

export const TIER_PRICE_AIN: Record<Exclude<Tier, "free">, number> = {
  pro: 5,
  max: 50,
};
/** 30 days for paid tier lifts. */
export const TIER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Multiplier applied to a route's base rate-limit budget. */
export const TIER_MULTIPLIER: Record<Tier, number> = { free: 1, pro: 5, max: 50 };

/** Per-owner storage caps (file + folder count, summed across all drives). */
export const TIER_FILE_LIMIT: Record<Tier, number> = {
  free: 1_000,
  pro: 100_000,
  max: Number.POSITIVE_INFINITY,
};
// Folder creation is unlimited on every tier: empty dirs are cheap and are not a
// paid boundary. (The mkdir route only enforces a cap when this is finite, so
// Infinity disables the check; the file-count cap + rate limits still apply.)
export const TIER_FOLDER_LIMIT: Record<Tier, number> = {
  free: Number.POSITIVE_INFINITY,
  pro: Number.POSITIVE_INFINITY,
  max: Number.POSITIVE_INFINITY,
};

/**
 * Hard upper bound on agents per drive — anti-abuse only, NOT a billing
 * dimension. Real usage is metered on the ask path via tier rate limits.
 */
export const HARD_MAX_AGENTS_PER_DRIVE = 1000;

type TierGrant = { tier: Tier; expiresAt: number | null };

/** Highest tier any of `wallets` holds an active lift for (latest expiry wins). */
function tierForWallets(wallets: string[]): TierGrant {
  for (const tier of ["max", "pro"] as const) {
    let expiresAt: number | null = null;
    for (const w of wallets) {
      const exp = getActiveLiftExpiry(w, `tier:${tier}`);
      if (exp != null && (expiresAt == null || exp > expiresAt)) expiresAt = exp;
    }
    if (expiresAt != null) return { tier, expiresAt };
  }
  return { tier: "free", expiresAt: null };
}

export async function getUserTier(_req?: Request): Promise<TierGrant> {
  const wallet = await getWallet();
  return wallet ? tierForWallets([wallet]) : { tier: "free", expiresAt: null };
}

/**
 * Every wallet linked to an account, lowercased. A wallet-provisioned account
 * (`<address>@wallet.aindrive.local`) always has its address among them.
 */
export function accountWallets(userId: string): string[] {
  const rows = db
    .prepare("SELECT wallet_address FROM account_wallets WHERE account_id = ?")
    .all(userId) as { wallet_address: string }[];
  return rows.map((r) => r.wallet_address.toLowerCase());
}

/** The account's tier: the best active lift on any wallet linked to it. */
export function getAccountTier(userId: string): TierGrant {
  return tierForWallets(accountWallets(userId));
}

export type OwnerStorageCaps = {
  tier: Tier;
  fileLimit: number;
  folderLimit: number;
};

/**
 * Storage caps for the drives of `ownerId` — the drive's owner_id, never the
 * caller. Resolution is identical for session, MCP PAT and account-token
 * writes, since it reads nothing from the request.
 */
export function getOwnerStorageCaps(ownerId: string): OwnerStorageCaps {
  const { tier } = getAccountTier(ownerId);
  return { tier, fileLimit: TIER_FILE_LIMIT[tier], folderLimit: TIER_FOLDER_LIMIT[tier] };
}

export function tierBudget(tier: Tier, base: { limit: number; windowMs: number }) {
  return { limit: base.limit * TIER_MULTIPLIER[tier], windowMs: base.windowMs };
}
