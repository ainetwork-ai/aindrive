/**
 * Tiered rate limits — Claude-Code-style "free / pro / max" plans.
 *
 *   getUserTier(req)  → "free" | "pro" | "max"
 *   tierBudget(tier, base) → { limit, windowMs }   (multiplier per tier)
 *
 * Upgrade flow:
 *   GET /api/x402/lift?scope=tier:pro&priceAin=5   → 30-day Pro tier
 *   GET /api/x402/lift?scope=tier:max&priceAin=50  → 30-day Max tier
 *
 * The lift entries land in `paid_lifts` and `getUserTier` reads them via
 * the wallet cookie. No tier means free; routes scale their existing
 * rate-limit budget with `tierBudget()`.
 */

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

export async function getUserTier(_req?: Request): Promise<{ tier: Tier; expiresAt: number | null }> {
  const wallet = await getWallet();
  if (!wallet) return { tier: "free", expiresAt: null };
  const maxExp = getActiveLiftExpiry(wallet, "tier:max");
  if (maxExp != null) return { tier: "max", expiresAt: maxExp };
  const proExp = getActiveLiftExpiry(wallet, "tier:pro");
  if (proExp != null) return { tier: "pro", expiresAt: proExp };
  return { tier: "free", expiresAt: null };
}

export function tierBudget(tier: Tier, base: { limit: number; windowMs: number }) {
  return { limit: base.limit * TIER_MULTIPLIER[tier], windowMs: base.windowMs };
}
