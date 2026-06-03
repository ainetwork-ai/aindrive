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
 * form (drive_members or folder_access — both written through API routes
 * that normalize on the way in). `targetPath` should also be normalized
 * by the caller before being passed here.
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
 * Decide the role granted by a set of free-share rows for a target path.
 *
 * This is the pure decision half of resolveRoleByShareGrants — DB lookup
 * lives in access.ts; this function just applies the rules so it can be
 * unit-tested without a database. A share row grants its role ONLY when:
 *   - it belongs to `driveId`,
 *   - it is FREE (price_usdc == null) — a paid share never grants here, so
 *     a leaked/forged grant cookie can't bypass a paywall,
 *   - it is not expired (relative to `now`),
 *   - and its (canonical) path is an ancestor-or-self of `targetPath`.
 *
 * @param {Array<{drive_id: string, path: string, role: string, price_usdc: number|null, expires_at: string|null}>} shareRows
 * @param {string} driveId
 * @param {string} targetPath  pre-normalized target
 * @param {Date} now
 * @returns {string} one of "none" | "viewer" | "editor" | "owner"
 */
export function pickFreeShareRole(shareRows, driveId, targetPath, now) {
  let best = "none";
  for (const s of shareRows) {
    if (s.drive_id !== driveId) continue;
    if (s.price_usdc != null) continue; // paid shares do NOT grant via free path
    if (s.expires_at && new Date(s.expires_at) < now) continue;
    if (!isAncestorOrSelf(s.path, targetPath)) continue;
    if ((ROLE_RANK[s.role] ?? 0) > (ROLE_RANK[best] ?? 0)) best = s.role;
  }
  return best;
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

export { normalizePath, isAncestorOrSelf };
