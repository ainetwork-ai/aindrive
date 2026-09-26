import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { mediaIndex } from "../media-index.js";

const vectors = JSON.parse(readFileSync(join(__dirname, "../../../web/shared/media/chunk-vectors.json"), "utf8"));
const pattern = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255);
const rootOf = (leaves) => createHash("sha256").update(Buffer.concat(leaves.map((h) => Buffer.from(h, "hex")))).digest("hex");

describe("media-index", () => {
  it("matches the shared chunk vectors (streaming, 1 MiB leaves)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "media-index-"));
    for (const { size, root } of vectors) {
      const f = join(dir, `f${size}`);
      writeFileSync(f, pattern(size));
      const r = await mediaIndex(f);
      expect(r.size).toBe(size);
      expect(r.chunk).toBe(1048576);
      expect(r.leaves.length).toBe(Math.ceil(size / 1048576));
      expect(rootOf(r.leaves)).toBe(root);
    }
  });

  it("re-indexes a file that changed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "media-index-"));
    const f = join(dir, "v.bin");
    writeFileSync(f, pattern(10));
    const a = await mediaIndex(f);
    writeFileSync(f, pattern(11));
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    const b = await mediaIndex(f);
    expect(b.size).toBe(11);
    expect(b.leaves[0]).not.toBe(a.leaves[0]);
  });
});
