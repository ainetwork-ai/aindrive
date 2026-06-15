// Paid carve-out: the read gate consults commerce. A priced subtree is removed
// from a bare viewer grant's reach — see docs/PERMISSIONS_MATRIX.md §1
// (R-ACC-PAID-*, R-ACC-NEST-001). This is the ONE place lib/access
// (drive_members) is crossed with shares + payment_receipts; access.ts itself
// stays commerce-free.
//
// Plain JS (+ sale-access.d.ts) like access-core.js so BOTH the HTTP gate
// (require-access.ts) and the WebSocket hub (dochub.js, run under raw
// `node server.js` with no TS build) share ONE implementation — no drift
// (R-AGENT-WS-002).
import { db } from "./db.js";
import { atLeast, canReadContent, isAncestorOrSelf } from "./access-core.js";

const depth = (p) => (p === "" ? 0 : p.split("/").length);

/**
 * The nearest gate covering `targetPath`: the deepest ancestor-or-self priced
 * share among `rows`, or null. Same inheritance as bestMatchingRole /
 * resolvePayoutWallet — "price this folder" guards everything under it until a
 * deeper sale carves out a more-specific gate.
 * @param {Array<{id:string,path:string,price_usdc:number,currency:string|null,expires_at:string|null}>} rows
 * @param {string} targetPath
 */
function nearestSale(rows, targetPath) {
  let best = null;
  for (const r of rows) {
    if (!isAncestorOrSelf(r.path, targetPath)) continue;
    if (!best || depth(r.path) > depth(best.path)) best = r;
  }
  return best;
}

/**
 * Classify a path by the nearest *active* priced share covering it.
 * @param {string} driveId
 * @param {string} targetPath
 * @returns {{ classification: "free"|"paid", gate: object|null }}
 */
export function classifyPath(driveId, targetPath) {
  const rows = db
    .prepare("SELECT id, path, price_usdc, currency, expires_at FROM shares WHERE drive_id = ? AND price_usdc IS NOT NULL")
    .all(driveId);
  // Expiry filtered in JS: expires_at is ISO text, so a SQL string compare vs
  // datetime('now') is unsafe at boundaries (same reasoning as showcase.ts). An
  // expired sale no longer gates — the path falls back to its role-based access.
  const active = rows.filter((r) => !r.expires_at || new Date(r.expires_at) >= new Date());
  const gate = nearestSale(active, targetPath);
  return { classification: gate ? "paid" : "free", gate };
}

/**
 * Does `accountId` hold a receipt for the sale AT `gatePath`? Exact-path match,
 * not ancestor: buying a parent folder does not unlock a deeper, separately
 * priced child (R-ACC-NEST-001) — the gate is already the nearest priced
 * ancestor, and receipts live at the share path that was settled.
 * @param {string} driveId
 * @param {string} accountId
 * @param {string} gatePath
 * @returns {boolean}
 */
export function hasPaidEntitlement(driveId, accountId, gatePath) {
  const row = db
    .prepare("SELECT 1 FROM payment_receipts WHERE drive_id = ? AND account_id = ? AND path = ? LIMIT 1")
    .get(driveId, accountId, gatePath);
  return !!row;
}

/**
 * Null if the actor may READ `targetPath`; otherwise a denial describing the
 * gate share so the caller can 402 → paywall. Decision routes through
 * canReadContent (PERMISSIONS_MATRIX.md §1). editor+ bypass (managers curate);
 * free content returns null (its role gate is enforced upstream by the
 * min-viewer check); a paid path denies unless the account holds a covering
 * entitlement. Callers gate this behind a passing min-viewer role check, so a
 * non-null result is always a paid gate.
 * @param {string} driveId
 * @param {string} targetPath
 * @param {"none"|"viewer"|"editor"|"owner"} role
 * @param {string|null} accountId
 * @returns {{ gatePath:string, shareId:string, price:number, currency:string|null }|null}
 */
export function paidAccessDenial(driveId, targetPath, role, accountId) {
  if (atLeast(role, "editor")) return null; // managers bypass — no DB work
  const { classification, gate } = classifyPath(driveId, targetPath);
  if (classification === "free" || !gate) return null;
  const hasEnt = accountId ? hasPaidEntitlement(driveId, accountId, gate.path) : false;
  if (canReadContent(role, "paid", hasEnt)) return null;
  return { gatePath: gate.path, shareId: gate.id, price: gate.price_usdc, currency: gate.currency };
}
