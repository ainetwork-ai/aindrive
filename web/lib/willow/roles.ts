// The two questions the Willow peer asks the rest of the app, with the same rules
// as dochub and the fs/* routes: this user's role on a path, and whether any
// priced path of the drive is closed to them (then they get no sync session, so a
// paid document can never reach them over Willow).
import { resolveRole } from "@/lib/dochub.js";
import { db } from "@/lib/db.js";
import { paidAccessDenial } from "@/lib/sale-access.js";

export const roleOf = (driveId: string, userId: string | null, path: string): string => resolveRole(driveId, userId, path);

export function blockedByPaywall(driveId: string, userId: string | null): boolean {
  const rows = db.prepare("SELECT path FROM shares WHERE drive_id = ? AND price_usdc IS NOT NULL").all(driveId) as { path: string }[];
  return rows.some((r) => paidAccessDenial(driveId, r.path, roleOf(driveId, userId, r.path) as Parameters<typeof paidAccessDenial>[2], userId) !== null);
}
