// Showcase (commerce layer): read-only view of a drive's listed paid shares,
// shown as an upsell to anyone who can't yet READ them. Depends on lib/access
// (role) + lib/sale-access (the paid carve-out) — never the reverse: those
// layers stay commerce-blind / showcase-blind.
import { db } from "./db";
import { resolveRoleByUser } from "./access";
import { paidAccessDenial } from "./sale-access.js";

export type ShowcaseItem = {
  shareId: string;
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
  expires_at: string | null;
  price_usdc: number;
  currency: string | null;
};

export function listShowcase(driveId: string, userId: string): ShowcaseItem[] {
  // token (URL slug) is deliberately NOT selected: it must not be bulk-handed
  // to drive members. Buyers reach the share via the per-shareId redirect route
  // (app/api/drives/[driveId]/showcase/[shareId]), which resolves the token
  // server-side behind the same membership gate.
  const rows = db.prepare(`
    SELECT id, path, role, expires_at, price_usdc, currency
    FROM shares
    WHERE drive_id = ? AND listed = 1 AND price_usdc IS NOT NULL
  `).all(driveId) as ListedShareRow[];
  return rows
    // [rev2-E] Expiry filtered in JS: expires_at is ISO ('T'/'Z') text, so a
    // SQL string comparison against datetime('now') is unsafe at boundaries.
    .filter((s) => !s.expires_at || new Date(s.expires_at) >= new Date())
    // An item is an upsell iff the caller can't currently READ it. Covered-by-
    // role no longer implies access (the paid carve-out), so we show every
    // listed paid item the caller is DENIED — which now includes a whole-drive
    // viewer's locked items (R-STORE-003). Managers (editor+) bypass the
    // carve-out → denial is null → they see an empty showcase; entitled buyers
    // (receipt/comp) are likewise excluded.
    .filter((s) => paidAccessDenial(driveId, s.path, resolveRoleByUser(driveId, userId, s.path), userId) !== null)
    .map((s) => ({
      shareId: s.id,
      leafName: s.path.split("/").pop() || "(drive)",
      role: s.role,
      price: s.price_usdc,
      currency: s.currency,
    }));
}
