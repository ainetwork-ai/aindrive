import { NextResponse } from "next/server";
import { getUserTier, TIER_PRICE_AIN, TIER_MULTIPLIER, TIER_TTL_MS } from "@/lib/tier";

/**
 * GET /api/me/tier
 *
 *   { tier: "free" | "pro" | "max",
 *     expiresAt: number | null,
 *     prices: { pro: 5, max: 50 },
 *     multiplier: { free: 1, pro: 5, max: 50 },
 *     ttlDays: 30,
 *     upgradeUrls: { pro: "/api/x402/lift?scope=tier:pro&priceAin=5",
 *                    max: "/api/x402/lift?scope=tier:max&priceAin=50" } }
 *
 * UI consumes this to render the upgrade banner.
 */
export async function GET(req: Request) {
  const { tier, expiresAt } = await getUserTier(req);
  return NextResponse.json({
    tier,
    expiresAt,
    prices: TIER_PRICE_AIN,
    multiplier: TIER_MULTIPLIER,
    ttlDays: Math.round(TIER_TTL_MS / (24 * 60 * 60 * 1000)),
    upgradeUrls: {
      pro: `/api/x402/lift?scope=tier:pro&priceAin=${TIER_PRICE_AIN.pro}`,
      max: `/api/x402/lift?scope=tier:max&priceAin=${TIER_PRICE_AIN.max}`,
    },
  });
}
