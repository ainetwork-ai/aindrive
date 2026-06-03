import type { PathError, NormalizedPath } from "./path";

export type Role = "viewer" | "editor" | "owner";
export type RoleOrNone = Role | "none";

export declare const ROLE_RANK: Readonly<Record<RoleOrNone, number>>;

export declare function atLeast(level: RoleOrNone | string, required: RoleOrNone | string): boolean;

export declare function bestMatchingRole(
  rows: { path: NormalizedPath; role: Role }[],
  targetPath: NormalizedPath
): RoleOrNone;

export declare function mergeRoleUpgradeOnly(
  current: RoleOrNone,
  incoming: Role
): Role;

export declare function pickFreeShareRole(
  shareRows: {
    drive_id: string;
    path: NormalizedPath;
    role: Role;
    price_usdc: number | null;
    expires_at: string | null;
  }[],
  driveId: string,
  targetPath: NormalizedPath,
  now: Date
): RoleOrNone;

export { normalizePath, isAncestorOrSelf } from "./path";
export type { PathError, NormalizedPath };
