/**
 * The ONE listing rule (ain-integration plan task 06.5): which children of a
 * folder a caller may see, and which of those are locked. Every surface that
 * shows names — fs/list (cookie, session bearer, resource delegation), the
 * list_files / stat / search skills (MCP, A2A, AG-UI) — goes through
 * `visibleChildren`, so a name hidden in one is hidden in all.
 *
 *   hidden   the reserved `.aindrive/` subtree (any letter case, even if an
 *            agent forgets to leave it out), and an UNLISTED paid child the
 *            caller is not entitled to (R-VIS-PAID-001: a private sale).
 *   locked   a LISTED paid child the caller is not entitled to: shown with
 *            the price so the paywall can sell it; its content, thumbnail and
 *            bytes stay behind the read gate (require-access.ts readDenial →
 *            402), and search never descends into it.
 *   open     everything else the caller's role at the folder reaches.
 *
 * editor+ see every non-reserved child (paidLocksForListing gives them no locks).
 * The read gate (requireDriveRole → readDenial) is the same decision for one
 * path: a name `visibleChildren` shows as open is readable, a locked or hidden
 * one is not (tests: lib/__tests__/visibility-rule.test.ts).
 */
import { paidLocksForListing } from "./sale-access.js";
import { isSystemPath } from "@/shared/domain/policy/system-paths";
import type { RoleOrNone } from "./access-core";

export type ChildLock = { price: number; currency: string | null; shareId: string; listed: boolean };
export type VisibleChild<E> = { entry: E; lock: ChildLock | null };

const childPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

export function visibleChildren<E extends { name: string }>(
  driveId: string,
  dir: string,
  entries: E[],
  role: RoleOrNone,
  userId: string | null,
): VisibleChild<E>[] {
  const safe = entries.filter((e) => typeof e?.name === "string" && !isSystemPath(childPath(dir, e.name)));
  const locks = paidLocksForListing(driveId, dir, safe.map((e) => e.name), role, userId);
  const out: VisibleChild<E>[] = [];
  for (const e of safe) {
    const lock = locks[e.name] ?? null;
    if (lock && !lock.listed) continue; // private sale: not even the name
    out.push({ entry: e, lock });
  }
  return out;
}
