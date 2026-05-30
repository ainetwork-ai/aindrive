import mimeTypes from "mime-types";

/**
 * Classify a path/filename into "text" (UTF-8 readable in an editor) or
 * "binary" (image, PDF, archive, …). Used by the fs/read API to decide
 * automatically which transport encoding to use, so callers can keep their
 * code simple (request /fs/read, receive {content, encoding, mime}).
 *
 * Mime-types lookup returns "false" for unknown extensions; we treat those
 * as binary so unknown files don't get mojibaked when shipped over JSON.
 */
const TEXT_EXTRA_PREFIXES = ["application/json", "application/xml", "application/yaml", "application/x-yaml", "application/javascript", "application/typescript", "application/x-sh"];

export function lookupMime(path: string): string | null {
  const m = mimeTypes.lookup(path);
  return m === false ? null : m;
}

export function classifyKind(path: string): { kind: "text" | "binary"; mime: string } {
  const mime = lookupMime(path);
  if (!mime) return { kind: "binary", mime: "application/octet-stream" };
  if (mime.startsWith("text/")) return { kind: "text", mime };
  if (TEXT_EXTRA_PREFIXES.some((p) => mime === p || mime.startsWith(p + ";"))) {
    return { kind: "text", mime };
  }
  // SVG is text-shaped but typically rendered as image; treat as binary for
  // the fs/read flow so it surfaces in <img src> rather than the editor.
  return { kind: "binary", mime };
}

/** Filename suitable for the Content-Disposition: attachment header. */
export function basenameForDownload(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}
