import { z } from "zod";
import { normalizePath, PathError, type NormalizedPath } from "./path";

/**
 * Zod field for a drive-relative path. Accepts any user input and either:
 *   - transforms it to canonical form via normalizePath(), OR
 *   - emits a validation issue if the input is structurally invalid (".."
 *     segments, null bytes, non-string).
 *
 * Use this wherever an API accepts a path in a JSON body. For URL search
 * params, call normalizePath directly inside the route handler.
 */
export const zPath = z.string().transform((v, ctx) => {
  try {
    return normalizePath(v);
  } catch (e) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: e instanceof PathError ? e.message : "invalid path",
    });
    return z.NEVER;
  }
});

/** Like zPath but rejects the empty (drive-root) string. */
export const zRequiredPath = zPath.refine((s) => s.length > 0, { message: "path is required" });

/**
 * Helper for URL search params: returns the normalized path or throws a
 * Response-ready error. Use like:
 *
 *   try { path = parseSearchPath(url); }
 *   catch (r) { return r; }
 */
export function parseSearchPath(url: URL, paramName = "path"): NormalizedPath {
  try {
    return normalizePath(url.searchParams.get(paramName) ?? "");
  } catch (e) {
    const message = e instanceof PathError ? e.message : "invalid path";
    throw new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
}
