// The questions the Willow peer asks the rest of the app, with the same rules as
// dochub and the fs/* routes: a user's role on a path, whether they are a member
// of the drive at all (any role, any path), and whether a path is behind a
// paywall for them. Checked per entry, on every send, so a role or price change
// takes effect mid-session.
import { resolveRole } from "@/lib/dochub.js";
import { db } from "@/lib/db.js";
import { paidAccessDenial } from "@/lib/sale-access.js";

export const roleOf = (driveId: string, userId: string | null, path: string): string => resolveRole(driveId, userId, path);

export function isMember(driveId: string, userId: string | null): boolean {
  if (!userId) return false;
  const owner = db.prepare("SELECT 1 FROM drives WHERE id = ? AND owner_id = ?").get(driveId, userId);
  return !!owner || !!db.prepare("SELECT 1 FROM drive_members WHERE drive_id = ? AND user_id = ? LIMIT 1").get(driveId, userId);
}

export function paywalled(driveId: string, userId: string | null, path: string): boolean {
  return paidAccessDenial(driveId, path, roleOf(driveId, userId, path) as Parameters<typeof paidAccessDenial>[2], userId) !== null;
}
