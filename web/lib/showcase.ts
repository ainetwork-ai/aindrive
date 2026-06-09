// Showcase (commerce layer): read-only view of a drive's listed paid shares,
// shown as an upsell to members who don't cover those paths yet. Depends on
// lib/access for role lookups — never the reverse: access stays commerce-free
// (drive_members alone decides access; listed/price/currency play no part).
import { db } from "./db";
import { resolveRoleByUser } from "./access";

export type ShowcaseItem = {
  shareId: string;
  token: string;
  /** Last path segment only — the full share path is never exposed here:
   *  ancestor directory names would leak structure the caller has no access
   *  to (security C1). Root ("") shares are labelled "(drive)". */
  leafName: string;
  role: string;
  price: number;
  currency: string | null;
};

type ListedShareRow = {
  id: string;
  path: string;
  role: string;
  token: string;
  expires_at: string | null;
  price_usdc: number;
  currency: string | null;
};

export function listShowcase(driveId: string, userId: string): ShowcaseItem[] {
  const rows = db.prepare(`
    SELECT id, path, role, token, expires_at, price_usdc, currency
    FROM shares
    WHERE drive_id = ? AND listed = 1 AND price_usdc IS NOT NULL
  `).all(driveId) as ListedShareRow[];
  return rows
    // [rev2-E] Expiry filtered in JS: expires_at is ISO ('T'/'Z') text, so a
    // SQL string comparison against datetime('now') is unsafe at boundaries.
    .filter((s) => !s.expires_at || new Date(s.expires_at) >= new Date())
    // A path the caller already covers is not an upsell — keep only what
    // they can't reach yet.
    .filter((s) => resolveRoleByUser(driveId, userId, s.path) === "none")
    .map((s) => ({
      shareId: s.id,
      token: s.token,
      leafName: s.path.split("/").pop() || "(drive)",
      role: s.role,
      price: s.price_usdc,
      currency: s.currency,
    }));
}
