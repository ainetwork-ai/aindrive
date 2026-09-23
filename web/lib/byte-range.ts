// Single-range HTTP Range parsing shared by the byte-serving routes (fs/stream,
// fs/preview). Multipart ranges are not worth the complexity for media
// playback / pdf.js, so only one range is honored.

export type ByteRange =
  | { ok: true; start: number; endExclusive: number; partial: boolean }
  | { ok: false; error: "malformed range" | "range not satisfiable" };

/** Grammar: bytes=a-b | bytes=a- | bytes=-n. No header → the whole body. */
export function parseByteRange(header: string | null, size: number): ByteRange {
  if (!header) return { ok: true, start: 0, endExclusive: size, partial: false };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  const first = m?.[1] ?? "";
  const last = m?.[2] ?? "";
  if (!m || (first === "" && last === "")) return { ok: false, error: "malformed range" };
  let start: number;
  let endExclusive = size;
  if (first === "") {
    // suffix form: last n bytes
    start = size - Math.min(parseInt(last, 10), size);
  } else {
    start = parseInt(first, 10);
    endExclusive = last === "" ? size : Math.min(parseInt(last, 10) + 1, size);
  }
  if (start >= size || start >= endExclusive) return { ok: false, error: "range not satisfiable" };
  return { ok: true, start, endExclusive, partial: true };
}
