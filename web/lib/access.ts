import { eq, and } from "drizzle-orm";
import { drizzleDb } from "./db";
import { drives, drive_members } from "../drizzle/schema";
import { ROLE_RANK, atLeast, bestMatchingRole, computeEntry, normalizePath, type Role, type RoleOrNone } from "./access-core.js";
import { orgRoleInDrive } from "./orgs.js";
import { type NormalizedPath } from "./path";

export type { Role, RoleOrNone };

/**
 * The grants a user holds in a drive: their drive_members rows plus, when the
 * drive is shared with an organization they are an active member of, that
 * organization's role as a whole-drive ("") grant (lib/orgs.js). Merged by
 * rank like any two grants, so an org grant never lowers a personal one.
 */
function grantRows(driveId: string, userId: string): { path: NormalizedPath; role: Role }[] {
  // DB invariant: drive_members.path is written through zPath at every
  // API boundary, so every persisted row is already in canonical form.
  // Asserting NormalizedPath here is therefore safe.
  const rows = drizzleDb
    .select({ path: drive_members.path, role: drive_members.role })
    .from(drive_members)
    .where(and(eq(drive_members.drive_id, driveId), eq(drive_members.user_id, userId)))
    .all() as { path: NormalizedPath; role: Role }[];
  const orgRole = orgRoleInDrive(driveId, userId);
  if (orgRole !== "none") rows.push({ path: "" as NormalizedPath, role: orgRole });
  return rows;
}

/** Owner of the drive, else the best covering grant (member row or organization). */
export function resolveRoleByUser(driveId: string, userId: string, targetPath: string): RoleOrNone {
  const target = normalizePath(targetPath);
  const drive = drizzleDb
    .select({ owner_id: drives.owner_id })
    .from(drives)
    .where(eq(drives.id, driveId))
    .get();
  if (!drive) return "none";
  if (drive.owner_id === userId) return "owner";
  return bestMatchingRole(grantRows(driveId, userId), target);
}

/**
 * Compute a user's entry point into a drive (pure logic in computeEntry).
 * Returns {kind:"root"|"single"|"multi"|"none", path?, allPaths?}. Used by the
 * drive page to land path-scoped members on an accessible path instead of
 * rejecting them at root. Reads only grants + ownership (access layer); an
 * organization grant is whole-drive, so its members enter at the root.
 */
export function entryView(driveId: string, userId: string) {
  const drive = drizzleDb
    .select({ owner_id: drives.owner_id })
    .from(drives)
    .where(eq(drives.id, driveId))
    .get();
  if (!drive) return { kind: "none" as const };
  const isOwner = drive.owner_id === userId;
  return computeEntry(isOwner ? [] : grantRows(driveId, userId), isOwner);
}

/**
 * Combined role resolution — now a single source.
 *
 * Access is granted ONLY through drive ownership, a covering drive_members
 * row, or an organization the drive is shared with (resolveRoleByUser). Both
 * free shares (CONSUME -> drive_members) and paid shares (settle ->
 * drive_members) write membership rows, so there is no separate
 * wallet-allowlist or free-share-cookie path to consult.
 *
 * Stays async (and tolerates a null userId) so existing call sites — many of
 * which await this and pass a possibly-null session id — don't have to change.
 */
export async function resolveAccess(
  driveId: string,
  targetPath: string,
  userId: string | null
): Promise<RoleOrNone> {
  if (!userId) return "none";
  return resolveRoleByUser(driveId, userId, targetPath);
}

/** Backwards compat — keep the old name pointing at the user-only path. */
export function resolveRole(driveId: string, userId: string, targetPath: string): RoleOrNone {
  return resolveRoleByUser(driveId, userId, targetPath);
}

export { atLeast, ROLE_RANK };
