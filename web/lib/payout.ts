// Path-scoped payout resolution. A paid share's funds go to the wallet of the
// nearest ANCESTOR path — the same inheritance bestMatchingRole uses for roles,
// so "set a wallet on this folder" behaves exactly like "grant a role on this
// folder". Pure (rows + path in → wallet out) so it's unit-testable and shared
// by the settle route + the share-create gate.
import { isAncestorOrSelf } from "@/lib/access-core.js";
import type { NormalizedPath } from "@/lib/path";

export type PayoutRow = { path: string; wallet: string };

/**
 * The payout wallet for `targetPath`: the wallet on the deepest ancestor-or-self
 * path among `rows`. null when nothing (not even the root "") covers it.
 * `rows.path` and `targetPath` must already be normalized (API routes do this);
 * the `as NormalizedPath` casts assert that contract (same pattern as
 * bestMatchingRole).
 */
export function resolvePayoutWallet(rows: PayoutRow[], targetPath: string): string | null {
  const target = targetPath as NormalizedPath;
  let best: PayoutRow | null = null;
  for (const r of rows) {
    if (!isAncestorOrSelf(r.path as NormalizedPath, target)) continue;
    // Deeper (more "/") ancestor wins; "" (root) has depth 0 and loses to any.
    if (!best || depth(r.path) > depth(best.path)) best = r;
  }
  return best ? best.wallet : null;
}

function depth(p: string): number {
  return p === "" ? 0 : p.split("/").length;
}
