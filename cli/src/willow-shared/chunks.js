// GENERATED from web/shared/media/chunks.ts by web/scripts/mirror-willow-to-cli.mjs — do not edit.
import { sha256 } from "@noble/hashes/sha2.js";
import { equalBytes } from "./bytes.js";
const CHUNK_BYTES = 1048576;
async function leafHashes(data) {
  const leaves = [];
  if (data instanceof Uint8Array) {
    for (let i = 0; i < data.length; i += CHUNK_BYTES) leaves.push(sha256(data.subarray(i, i + CHUNK_BYTES)));
    return leaves;
  }
  let buf = new Uint8Array(CHUNK_BYTES);
  let fill = 0;
  for await (const piece of data) {
    let off = 0;
    while (off < piece.length) {
      const n = Math.min(CHUNK_BYTES - fill, piece.length - off);
      buf.set(piece.subarray(off, off + n), fill);
      fill += n;
      off += n;
      if (fill === CHUNK_BYTES) {
        leaves.push(sha256(buf));
        buf = new Uint8Array(CHUNK_BYTES);
        fill = 0;
      }
    }
  }
  if (fill > 0) leaves.push(sha256(buf.subarray(0, fill)));
  return leaves;
}
const outboardOf = (leaves) => {
  const out = new Uint8Array(leaves.length * 32);
  leaves.forEach((l, i) => out.set(l, i * 32));
  return out;
};
const leavesOf = (outboard) => Array.from({ length: outboard.length / 32 }, (_, i) => outboard.slice(i * 32, i * 32 + 32));
const rootOf = (leaves) => sha256(outboardOf(leaves));
function verifyChunk(chunk, index, outboard, root) {
  if (outboard.length % 32 !== 0 || !equalBytes(sha256(outboard), root)) return false;
  const count = outboard.length / 32;
  if (index < 0 || index >= count) return false;
  if (index < count - 1 && chunk.length !== CHUNK_BYTES) return false;
  if (chunk.length === 0 || chunk.length > CHUNK_BYTES) return false;
  return equalBytes(sha256(chunk), outboard.subarray(index * 32, index * 32 + 32));
}
export {
  CHUNK_BYTES,
  leafHashes,
  leavesOf,
  outboardOf,
  rootOf,
  verifyChunk
};
