import type { PathError } from "./path";

export type Role = "viewer" | "commenter" | "editor" | "owner";
export type RoleOrNone = Role | "none";

export declare const ROLE_RANK: Readonly<Record<RoleOrNone, number>>;

export declare function atLeast(level: RoleOrNone | string, required: RoleOrNone | string): boolean;

export declare function bestMatchingRole(
  rows: { path: string; role: Role }[],
  targetPath: string
): RoleOrNone;

export { normalizePath, isAncestorOrSelf } from "./path";
export type { PathError };
