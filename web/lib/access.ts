import { db } from "./db";
import { getWallet } from "./wallet";

export type Role = "viewer" | "commenter" | "editor" | "owner";
const rank: Record<Role | "none", number> = { none: 0, viewer: 1, commenter: 2, editor: 3, owner: 4 };

function isAncestorOrSelf(ancestor: string, target: string): boolean {
  if (!ancestor) return true;
  if (ancestor === target) return true;
  return target.startsWith(ancestor + "/");
}

/** Owner-of-drive or member-of-drive role lookup by user id. */
export function resolveRoleByUser(driveId: string, userId: string, targetPath: string): Role | "none" {
  const drive = db.prepare("SELECT owner_id FROM drives WHERE id = ?").get(driveId) as
    | { owner_id: string }
    | undefined;
  if (!drive) return "none";
  if (drive.owner_id === userId) return "owner";
  const members = db
    .prepare("SELECT path, role FROM drive_members WHERE drive_id = ? AND user_id = ?")
    .all(driveId, userId) as { path: string; role: Role }[];
  let best: Role | "none" = "none";
  for (const m of members) {
    if (isAncestorOrSelf(m.path, targetPath) && rank[m.role] > rank[best]) best = m.role;
  }
  return best;
}

/** Folder-access list lookup by wallet address. Returns the highest matching row's role. */
export function resolveRoleByWallet(driveId: string, wallet: string, targetPath: string): Role | "none" {
  const rows = db
    .prepare("SELECT path, role FROM folder_access WHERE drive_id = ? AND wallet_address = ?")
    .all(driveId, wallet.toLowerCase()) as { path: string; role: Role }[];
  let best: Role | "none" = "none";
  for (const r of rows) {
    if (isAncestorOrSelf(r.path, targetPath) && rank[r.role] > rank[best]) best = r.role;
  }
  return best;
}

/**
 * Combined role resolution: prefers user session, falls back to wallet allowlist.
 * Use this from API routes that may be hit by either authenticated users or wallet-only visitors.
 */
export async function resolveAccess(
  driveId: string,
  targetPath: string,
  userId: string | null
): Promise<Role | "none"> {
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
export function resolveRole(driveId: string, userId: string, targetPath: string): Role | "none" {
  return resolveRoleByUser(driveId, userId, targetPath);
}

export function atLeast(level: Role | "none", required: Role): boolean {
  return rank[level] >= rank[required];
}
