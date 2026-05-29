import { eq, and } from "drizzle-orm";
import { drizzleDb } from "./db";
import { drives, drive_members, folder_access, shares } from "../drizzle/schema";
import { getWallet } from "./wallet";
import { readShareGrants } from "./share-grant";
import { ROLE_RANK, atLeast, bestMatchingRole, pickFreeShareRole, normalizePath, type Role, type RoleOrNone } from "./access-core.js";
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
 * Free-share grant lookup. A link-only visitor carries a signed cookie
 * listing the share tokens they have opened (see lib/share-grant.ts). For
 * each token we look up the share and grant its role ONLY when:
 *   - the share belongs to this drive,
 *   - the share is FREE (price_usdc IS NULL) — paid shares never grant via
 *     this path, so a leaked/forged cookie can't bypass a paywall,
 *   - not expired,
 *   - and the share's path is an ancestor-or-self of the target.
 */
export function resolveRoleByShareGrants(
  driveId: string,
  grantedTokens: string[],
  targetPath: string
): RoleOrNone {
  if (grantedTokens.length === 0) return "none";
  const target = normalizePath(targetPath);
  // Look the tokens up, then hand the rows to the pure decision function
  // (pickFreeShareRole) which enforces free-only / not-expired / ancestor.
  const rows = grantedTokens
    .map((token) =>
      drizzleDb
        .select({
          drive_id: shares.drive_id,
          path: shares.path,
          role: shares.role,
          price_usdc: shares.price_usdc,
          expires_at: shares.expires_at,
        })
        .from(shares)
        .where(eq(shares.token, token))
        .get()
    )
    .filter((r): r is NonNullable<typeof r> => r != null) as {
      drive_id: string;
      path: NormalizedPath;
      role: Role;
      price_usdc: number | null;
      expires_at: string | null;
    }[];
  return pickFreeShareRole(rows, driveId, target, new Date());
}

/**
 * Combined role resolution, in priority order:
 *   1. user session  (drive owner / member)
 *   2. wallet allowlist  (owner-added or paid grant)
 *   3. free-share grant cookie  (link-only visitor of a FREE share)
 *
 * Use this from API routes that may be hit by authenticated users,
 * wallet-only visitors, or anonymous free-share visitors.
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
  const grants = await readShareGrants();
  if (grants.length > 0) {
    const r = resolveRoleByShareGrants(driveId, grants, targetPath);
    if (r !== "none") return r;
  }
  return "none";
}

/** Backwards compat — keep the old name pointing at the user-only path. */
export function resolveRole(driveId: string, userId: string, targetPath: string): RoleOrNone {
  return resolveRoleByUser(driveId, userId, targetPath);
}

export { atLeast, ROLE_RANK };
