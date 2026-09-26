// web/lib/__tests__/media-chunks.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHUNK_BYTES, leafHashes, rootOf, outboardOf, verifyChunk } from "@/shared/media/chunks";
import { toHex } from "@/shared/willow/bytes";

const pattern = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255);

describe("chunked media digest", () => {
  it("leaf counts at the edges", async () => {
    expect(await leafHashes(new Uint8Array(0))).toHaveLength(0);
    expect(await leafHashes(pattern(1))).toHaveLength(1);
    expect(await leafHashes(pattern(CHUNK_BYTES))).toHaveLength(1);
    expect(await leafHashes(pattern(CHUNK_BYTES + 1))).toHaveLength(2);
    expect(await leafHashes(pattern(3 * CHUNK_BYTES))).toHaveLength(3);
  });

  it("streaming in odd pieces gives the same leaves as one buffer", async () => {
    const data = pattern(2 * CHUNK_BYTES + 12345);
    async function* pieces() { for (let i = 0; i < data.length; i += 99_991) yield data.slice(i, i + 99_991); }
    expect((await leafHashes(pieces())).map(toHex)).toEqual((await leafHashes(data)).map(toHex));
  });

  it("verifies each chunk and refuses a corrupted one or a forged outboard", async () => {
    const data = pattern(2 * CHUNK_BYTES + 10);
    const leaves = await leafHashes(data);
    const root = rootOf(leaves);
    const ob = outboardOf(leaves);
    const chunk = (i: number) => data.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
    expect([0, 1, 2].every((i) => verifyChunk(chunk(i), i, ob, root))).toBe(true);
    const bad = chunk(1); bad[5] ^= 1;
    expect(verifyChunk(bad, 1, ob, root)).toBe(false);
    const forged = ob.slice(); forged[0] ^= 1;
    expect(verifyChunk(chunk(0), 0, forged, root)).toBe(false);
    expect(verifyChunk(chunk(0).slice(0, 10), 0, ob, root)).toBe(false); // a short non-final chunk
  });

  it("matches the cross-language vectors", async () => {
    const v = JSON.parse(readFileSync(join(__dirname, "../../shared/media/chunk-vectors.json"), "utf8")) as { size: number; root: string }[];
    for (const { size, root } of v) expect(toHex(rootOf(await leafHashes(pattern(size))))).toBe(root);
  });
});
