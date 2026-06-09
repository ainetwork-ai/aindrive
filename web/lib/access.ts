import { eq, and } from "drizzle-orm";
import { drizzleDb } from "./db";
import { drives, drive_members } from "../drizzle/schema";
import { ROLE_RANK, atLeast, bestMatchingRole, computeEntry, normalizePath, type Role, type RoleOrNone } from "./access-core.js";
import { type NormalizedPath } from "./path";

export type { Role, RoleOrNone };

/** Owner-of-drive or member-of-drive role lookup by user id. */
export function resolveRoleByUser(driveId: string, userId: string, targetPath: string): RoleOrNone {
  const target = normalizePath(targetPath);
  const drive = drizzleDb
    .select({ owner_id: drives.owner_id })
    .from(drives)
    .where(eq(drives.id, driveId))
    .get();
  if (!drive) return "none";
  if (drive.owner_id === userId) return "owner";
  // DB invariant: drive_members.path is written through zPath at every
  // API boundary, so every persisted row is already in canonical form.
  // Asserting NormalizedPath here is therefore safe.
  const members = drizzleDb
    .select({ path: drive_members.path, role: drive_members.role })
    .from(drive_members)
    .where(and(eq(drive_members.drive_id, driveId), eq(drive_members.user_id, userId)))
    .all() as { path: NormalizedPath; role: Role }[];
  return bestMatchingRole(members, target);
}

/**
 * Compute a user's entry point into a drive (pure logic in computeEntry).
 * Returns {kind:"root"|"single"|"multi"|"none", path?, allPaths?}. Used by the
 * drive page to land path-scoped members on an accessible path instead of
 * rejecting them at root. Reads only drive_members + ownership (access layer).
 */
export function entryView(driveId: string, userId: string) {
  const drive = drizzleDb
    .select({ owner_id: drives.owner_id })
    .from(drives)
    .where(eq(drives.id, driveId))
    .get();
  if (!drive) return { kind: "none" as const };
  const isOwner = drive.owner_id === userId;
  // Same DB invariant as resolveRoleByUser: drive_members.path is persisted
  // through zPath, so every row is already a canonical NormalizedPath — the
  // branded-type assertion (required by computeEntry's signature) is safe.
  const rows = drizzleDb
    .select({ path: drive_members.path, role: drive_members.role })
    .from(drive_members)
    .where(and(eq(drive_members.drive_id, driveId), eq(drive_members.user_id, userId)))
    .all() as { path: NormalizedPath; role: Role }[];
  return computeEntry(rows, isOwner);
}

/**
 * Combined role resolution — now a single source.
 *
 * Access is granted ONLY through drive ownership or a covering drive_members
 * row (resolveRoleByUser). Both free shares (CONSUME -> drive_members) and
 * paid shares (settle -> drive_members) write membership rows, so there is no
 * separate wallet-allowlist or free-share-cookie path to consult.
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
