/**
 * FileRef.sourceUrl ("open original") — how aindrive spells a link to one
 * path of a drive, and how it opens one it (or a product) minted earlier.
 *
 * The contract form is `<origin>/d/<driveId>/<path>` with each segment
 * percent-encoded (shared-items.ts; afan core's `aindriveSourceUrl` spells the
 * same). The web app shows a path at `/d/<driveId>?path=<path>`, so the
 * catch-all route `app/d/[driveId]/[...path]` sends the first to the second.
 * That route only redirects: the drive page does every permission check
 * (session, role, reserved subtree, paywall), exactly as for a `?path=` link.
 */
import { normalizePath } from "./path.js";

/**
 * First segments that are pages of their own under /d/<driveId>/ — a static
 * route wins over the catch-all, so a top-level item with one of these names
 * cannot use the path form.
 */
export const RESERVED_DRIVE_SEGMENTS: ReadonlySet<string> = new Set(["manage"]);

/**
 * The sourceUrl for `cpath` (contract form: "/" or "/a/b", NFC) on a drive.
 * Path form, except a top-level name a static page owns, which gets the
 * page's own `?path=` form (both resolve; the path form is what earlier refs
 * carry, so the listing keeps it).
 */
export function sourceUrlFor(origin: string, driveId: string, cpath: string): string {
  const base = `${origin.replace(/\/+$/, "")}/d/${encodeURIComponent(driveId)}`;
  const segs = cpath.split("/").filter(Boolean);
  if (segs.length && RESERVED_DRIVE_SEGMENTS.has(segs[0])) return `${base}?${new URLSearchParams({ path: segs.join("/") })}`;
  return `${base}/${segs.map(encodeURIComponent).join("/")}`;
}

export type SourcePathRedirect = { ok: true; location: string } | { ok: false; status: 400; reason: string };

/**
 * Where a path-form link goes. `rawSegments` are the URL's still
 * percent-encoded segments after /d/<driveId>/ (Hangul, NFD spellings from
 * macOS, spaces as %20 — or "+" left by a form encoder, which stays a literal
 * "+", as in any path). Each is decoded once; a malformed escape, a "..", a
 * NUL or a segment that decodes to "/" or "\" is refused rather than
 * reinterpreted. The target is relative, so a proxy's bind address never
 * leaks into Location.
 */
export function sourcePathRedirect(driveId: string, rawSegments: readonly string[]): SourcePathRedirect {
  const parts: string[] = [];
  for (const raw of rawSegments) {
    let seg: string;
    try { seg = decodeURIComponent(raw); }
    catch { return { ok: false, status: 400, reason: "malformed percent-encoding" }; }
    if (seg.includes("/") || seg.includes("\\")) return { ok: false, status: 400, reason: "a path segment may not contain a slash" };
    if (seg === "..") return { ok: false, status: 400, reason: "path traversal" };
    parts.push(seg);
  }
  let path: string;
  try { path = normalizePath(parts.join("/")); }
  catch { return { ok: false, status: 400, reason: "invalid path" }; }
  const here = `/d/${encodeURIComponent(driveId)}`;
  return { ok: true, location: path ? `${here}?${new URLSearchParams({ path })}` : here };
}
