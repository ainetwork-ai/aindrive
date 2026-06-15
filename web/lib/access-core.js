// Pure logic shared by lib/access.ts (HTTP route handlers) and lib/dochub.js
// (WebSocket handler invoked from server.js without a Next.js build step).
//
// This module only knows about rows-from-DB and target paths — it does NOT
// know how to fetch a user session or a wallet cookie. Each caller handles
// credential extraction in its own environment (Next.js cookies() vs raw
// WebSocket headers), then hands rows + target to bestMatchingRole.

import { normalizePath, isAncestorOrSelf } from "./path.js";

export const ROLE_RANK = Object.freeze({
  none: 0,
  viewer: 1,
  editor: 2,
  owner: 3,
});

/**
 * @param {string} level    role observed (may be "none")
 * @param {string} required minimum role
 * @returns {boolean}
 */
export function atLeast(level, required) {
  return (ROLE_RANK[level] ?? 0) >= (ROLE_RANK[required] ?? 0);
}

/**
 * Pick the highest matching role from a list of grant rows.
 *
 * Rows must come from a table where `path` is already stored in normalized
 * form (drive_members — written through API routes that normalize on the way
 * in). `targetPath` should also be normalized by the caller before being
 * passed here.
 *
 * @param {Array<{path: string, role: string}>} rows
 * @param {string} targetPath  pre-normalized target
 * @returns {string} one of "none" | "viewer" | "editor" | "owner"
 */
export function bestMatchingRole(rows, targetPath) {
  let best = "none";
  for (const r of rows) {
    if (isAncestorOrSelf(r.path, targetPath) && (ROLE_RANK[r.role] ?? 0) > (ROLE_RANK[best] ?? 0)) {
      best = r.role;
    }
  }
  return best;
}

/**
 * Decide a user's entry point into a drive from their membership rows.
 *
 * Pure: same inputs → same output (deterministic), so it is unit-testable and
 * reusable by both the HTTP page (access.ts) and the WS handler (dochub.js).
 * Only consumes drive_members rows + an isOwner flag — knows nothing about
 * commerce (listed/price). Entry selection: collapse ancestor-covered paths,
 * then pick shallowest (fewest "/"), ties broken alphabetically.
 *
 * @param {Array<{path: string, role: string}>} rows  drive_members for (drive,user), path pre-normalized
 * @param {boolean} isOwner  true if user owns the drive
 * @returns {{kind:"root"|"single"|"multi"|"none", path?: string, allPaths?: string[]}}
 */
export function computeEntry(rows, isOwner) {
  if (isOwner) return { kind: "root", path: "" };
  if (!rows || rows.length === 0) return { kind: "none" };
  if (rows.some((r) => r.path === "")) return { kind: "root", path: "" };

  // Collapse paths covered by a shallower grant (ancestor wins as entry).
  const paths = rows.map((r) => r.path);
  const roots = paths.filter(
    (p) => !paths.some((q) => q !== p && isAncestorOrSelf(q, p))
  );
  // Dedup (two rows same path) + deterministic order: depth asc, then lexicographic.
  const uniq = [...new Set(roots)].sort((a, b) => {
    const da = a === "" ? 0 : a.split("/").length;
    const db = b === "" ? 0 : b.split("/").length;
    return da !== db ? da - db : a < b ? -1 : a > b ? 1 : 0;
  });
  if (uniq.length === 1) return { kind: "single", path: uniq[0] };
  return { kind: "multi", path: uniq[0], allPaths: uniq };
}

/**
 * Merge an incoming role into a current one WITHOUT ever downgrading.
 *
 * Used on the members upsert path: re-inviting / re-accepting a share for a
 * user who already has access must only ever raise their role. Returns
 * whichever of `current` / `incoming` has the higher ROLE_RANK; ties keep
 * `incoming` (same rank, same role).
 *
 * @param {"none"|"viewer"|"editor"|"owner"} current   existing role (may be "none")
 * @param {"viewer"|"editor"|"owner"} incoming          requested role (never "none")
 * @returns {"viewer"|"editor"|"owner"} the higher-ranked role
 */
export function mergeRoleUpgradeOnly(current, incoming) {
  return (ROLE_RANK[current] ?? 0) > (ROLE_RANK[incoming] ?? 0) ? current : incoming;
}

/**
 * Read-access decision for a CLASSIFIED path — the paid carve-out rule
 * (docs/PERMISSIONS_MATRIX.md §1, R-ACC-*).
 *
 * Today fs/* read routes gate purely on role (atLeast viewer). This pure rule
 * adds the commerce dimension: a priced ("paid") path is *removed* from a bare
 * viewer grant's reach — you need editor+ (you manage the content) or an
 * entitlement (you bought it, or were comped). Free paths behave as before.
 *
 * Preconditions — the CALLER resolves these (see PERMISSIONS_MATRIX.md §0):
 *  - role           bestMatchingRole at the path (ownership/creator ⇒ "owner")
 *  - classification "free" | "paid" (nearest-ancestor priced share ⇒ "paid")
 *  - hasEntitlement a receipt OR comp covering the gate path (paid paths only)
 *
 * NOT YET WIRED into the routes: the read routes must compute `classification`
 * (nearest-ancestor `shares` lookup) and `hasEntitlement`
 * (`payment_receipts`/comp) and call this. That wiring is the remaining work
 * (R-WIRE-* in permission-matrix.test.ts). "private"/"public" classifications
 * are future (PERMISSIONS_MATRIX.md §10) and intentionally rejected here so a
 * miswired caller fails loud instead of silently allowing.
 *
 * @param {"none"|"viewer"|"editor"|"owner"} role
 * @param {"free"|"paid"} classification
 * @param {boolean} hasEntitlement  receipt|comp covering the gate path
 * @returns {boolean} may the actor READ the path
 */
export function canReadContent(role, classification, hasEntitlement) {
  // Managers (editor+/owner/creator) always read — they curate the content.
  if (atLeast(role, "editor")) return true;
  if (classification === "free") return atLeast(role, "viewer");
  if (classification === "paid") return hasEntitlement === true;
  throw new Error(`canReadContent: unsupported classification "${classification}"`);
}

export { normalizePath, isAncestorOrSelf };
