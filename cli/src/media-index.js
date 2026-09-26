// A file's chunk hash list (P2P media spec M2): 1 MiB leaves, SHA-256 each,
// streamed so a multi-GB video never sits in memory. The server checks every chunk
// it fetches against this list; the root is SHA-256 over the concatenated leaves
// (web/shared/media/chunks.ts, vectors in web/shared/media/chunk-vectors.json).
import { createReadStream, statSync } from "node:fs";
import { createHash } from "node:crypto";

export const CHUNK = 1048576;
const memo = new Map(); // abs → { size, mtimeMs, result }

export async function mediaIndex(abs) {
  const st = statSync(abs);
  const hit = memo.get(abs);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.result;
  const leaves = [];
  let buf = Buffer.alloc(CHUNK), fill = 0;
  for await (const piece of createReadStream(abs, { highWaterMark: CHUNK })) {
    let off = 0;
    while (off < piece.length) {
      const n = Math.min(CHUNK - fill, piece.length - off);
      piece.copy(buf, fill, off, off + n);
      fill += n; off += n;
      if (fill === CHUNK) { leaves.push(createHash("sha256").update(buf).digest("hex")); fill = 0; }
    }
  }
  if (fill > 0) leaves.push(createHash("sha256").update(buf.subarray(0, fill)).digest("hex"));
  const result = { size: st.size, mtimeMs: st.mtimeMs, chunk: CHUNK, leaves };
  memo.set(abs, { size: st.size, mtimeMs: st.mtimeMs, result });
  if (memo.size > 500) memo.delete(memo.keys().next().value);
  return result;
}
