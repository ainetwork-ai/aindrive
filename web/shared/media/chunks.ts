// web/shared/media/chunks.ts
// The media payload digest (P2P media spec M2): 1 MiB leaves, SHA-256 each; the
// digest is SHA-256 over the concatenated leaves. The leaf list ("outboard", 32 B
// per MiB) lets any peer's chunk be checked on arrival. Mirrored by hand in Java
// and Swift (Plan 6); chunk-vectors.json keeps them identical.
import { sha256 } from "@noble/hashes/sha2.js";
import { equalBytes } from "../willow/bytes";

export const CHUNK_BYTES = 1_048_576;

export async function leafHashes(data: Uint8Array | AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const leaves: Uint8Array[] = [];
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
      fill += n; off += n;
      if (fill === CHUNK_BYTES) { leaves.push(sha256(buf)); buf = new Uint8Array(CHUNK_BYTES); fill = 0; }
    }
  }
  if (fill > 0) leaves.push(sha256(buf.subarray(0, fill)));
  return leaves;
}

export const outboardOf = (leaves: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(leaves.length * 32);
  leaves.forEach((l, i) => out.set(l, i * 32));
  return out;
};

export const leavesOf = (outboard: Uint8Array): Uint8Array[] =>
  Array.from({ length: outboard.length / 32 }, (_, i) => outboard.slice(i * 32, i * 32 + 32));

export const rootOf = (leaves: Uint8Array[]): Uint8Array => sha256(outboardOf(leaves));

export function verifyChunk(chunk: Uint8Array, index: number, outboard: Uint8Array, root: Uint8Array): boolean {
  if (outboard.length % 32 !== 0 || !equalBytes(sha256(outboard), root)) return false;
  const count = outboard.length / 32;
  if (index < 0 || index >= count) return false;
  if (index < count - 1 && chunk.length !== CHUNK_BYTES) return false;
  if (chunk.length === 0 || chunk.length > CHUNK_BYTES) return false;
  return equalBytes(sha256(chunk), outboard.subarray(index * 32, index * 32 + 32));
}
