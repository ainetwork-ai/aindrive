/**
 * Headers for serving file bytes whose type a user chose (a drive file's
 * extension, a handoff link's mime) on the app's own origin. Anything a browser
 * would run — HTML, SVG, XML, JS — would get same-origin script execution
 * against the visitor's session. Only browser-passive media stay inline; SVG
 * stays inline under a CSP sandbox (scripts dead if opened as a document, and
 * an <img> never runs them); everything else downloads as opaque bytes.
 */
function inlineSafe(mime: string): boolean {
  return (
    (mime.startsWith("image/") && mime !== "image/svg+xml") ||
    mime.startsWith("video/") ||
    mime.startsWith("audio/") ||
    mime === "application/pdf"
  );
}

/** Text no browser runs (served with nosniff): what an agent reads, not a page a visitor opens. */
const PASSIVE_TEXT = new Set(["text/plain", "text/markdown", "text/csv", "text/tab-separated-values", "application/json"]);

/**
 * `filename`, when given, is named in Content-Disposition (inline or attachment).
 * `text`: also serve passive text with its own type (+ charset) instead of opaque bytes — for
 * callers whose reader is an agent (handoff links); the caller must send `nosniff`.
 */
export function servedBytesHeaders(mime: string, filename?: string, opts: { text?: boolean } = {}): Record<string, string> {
  const name = filename === undefined ? "" : `; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  if (inlineSafe(mime)) return { "Content-Type": mime, ...(name ? { "Content-Disposition": `inline${name}` } : {}) };
  const base = mime.split(";")[0].trim().toLowerCase();
  if (opts.text && PASSIVE_TEXT.has(base)) return { "Content-Type": `${base}; charset=utf-8`, ...(name ? { "Content-Disposition": `inline${name}` } : {}) };
  if (mime === "image/svg+xml") {
    return { "Content-Type": mime, "Content-Security-Policy": "sandbox", ...(name ? { "Content-Disposition": `inline${name}` } : {}) };
  }
  return { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment${name}` };
}
