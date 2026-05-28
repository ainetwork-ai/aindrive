import { eq, and } from "drizzle-orm";
import { drizzleDb } from "./db";
import { drives, drive_members, folder_access } from "../drizzle/schema";
import { getWallet } from "./wallet";
import { ROLE_RANK, atLeast, bestMatchingRole, normalizePath, type Role, type RoleOrNone } from "./access-core.js";
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

/** Folder-access list lookup by wallet address. Returns the highest matching row's role. */
export function resolveRoleByWallet(driveId: string, wallet: string, targetPath: string): RoleOrNone {
  const target = normalizePath(targetPath);
  // Same DB invariant as resolveRoleByUser — folder_access.path is always
  // canonical at write time.
  const rows = drizzleDb
    .select({ path: folder_access.path, role: folder_access.role })
    .from(folder_access)
    .where(and(eq(folder_access.drive_id, driveId), eq(folder_access.wallet_address, wallet.toLowerCase())))
    .all() as { path: NormalizedPath; role: Role }[];
  return bestMatchingRole(rows, target);
}

/**
 * Combined role resolution: prefers user session, falls back to wallet allowlist.
 * Use this from API routes that may be hit by either authenticated users or wallet-only visitors.
 */
export async function resolveAccess(
  driveId: string,
  targetPath: string,
  userId: string | null
): Promise<RoleOrNone> {
  if (userId) {
    const r = resolveRoleByUser(driveId, userId, targetPath);
    if (r !== "none") return r;
  }
  const wallet = await getWallet();
  if (wallet) {
    const r = resolveRoleByWallet(driveId, wallet, targetPath);
    if (r !== "none") return r;
  }
  return "none";
}

/** Backwards compat — keep the old name pointing at the user-only path. */
export function resolveRole(driveId: string, userId: string, targetPath: string): RoleOrNone {
  return resolveRoleByUser(driveId, userId, targetPath);
}

export { atLeast, ROLE_RANK };
