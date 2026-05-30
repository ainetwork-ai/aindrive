export declare class PathError extends Error {
  constructor(reason: string);
}

/**
 * Branded string for "path in canonical form" — the result of normalizePath()
 * or any field guaranteed to have been written through it (DB columns are
 * normalized at INSERT time by the API layer).
 *
 * Pure compile-time marker: at runtime this is just `string`. The whole
 * point is to force callers of `isAncestorOrSelf` / `bestMatchingRole` to
 * prove they normalized the input — the strongest invariant of the
 * permission system becomes compile-checked instead of convention-checked.
 *
 * To assert that a string is already normalized (e.g. a value read from a
 * DB column whose write path goes through normalizePath), use:
 *   const path = row.path as NormalizedPath;
 */
export type NormalizedPath = string & { readonly __brand: "NormalizedPath" };

export declare function normalizePath(input: string): NormalizedPath;

export declare function isAncestorOrSelf(ancestor: NormalizedPath, target: NormalizedPath): boolean;
