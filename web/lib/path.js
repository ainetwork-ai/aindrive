/**
 * Canonical path normalization for aindrive.
 *
 * Every share/grant/access path stored in SQLite goes through normalizePath()
 * before persistence, and every lookup normalizes the target the same way.
 * This is the single source preventing "trailing-slash mismatch" type bugs
 * where two textually-different paths refer to the same logical location.
 *
 * Canonical form:
 *   - "" represents drive root
 *   - no leading slash, no trailing slash
 *   - no "./" segments, no consecutive slashes
 *   - rejects ".." segments and null bytes
 *
 * Callers MUST normalize both sides before any isAncestorOrSelf() check.
 *
 * Plain ESM .js so it can be imported from both Next.js routes (TypeScript)
 * and server.js-side handlers (lib/dochub.js, lib/agents.js) which are not
 * run through the Next.js build.
 */

export class PathError extends Error {
  constructor(reason) {
    super(`invalid path: ${reason}`);
    this.name = "PathError";
  }
}

// Checks for U+0000. Implemented with charCodeAt rather than a regex/string
// literal so the source file itself contains no raw NUL byte (which would
// make git treat this file as binary and break diffs).
function hasNulByte(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0) return true;
  }
  return false;
}

/**
 * @param {string} input
 * @returns {string}
 */
export function normalizePath(input) {
  if (typeof input !== "string") throw new PathError("must be string");
  if (hasNulByte(input)) throw new PathError("contains null byte");
  const segs = input.split("/").filter((s) => s.length > 0 && s !== ".");
  for (const s of segs) {
    if (s === "..") throw new PathError("contains '..' segment");
  }
  return segs.join("/");
}

/**
 * @param {string} ancestor
 * @param {string} target
 * @returns {boolean}
 */
export function isAncestorOrSelf(ancestor, target) {
  if (!ancestor) return true;
  if (ancestor === target) return true;
  return target.startsWith(ancestor + "/");
}
