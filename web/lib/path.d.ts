export declare class PathError extends Error {
  constructor(reason: string);
}

export declare function normalizePath(input: string): string;

export declare function isAncestorOrSelf(ancestor: string, target: string): boolean;
