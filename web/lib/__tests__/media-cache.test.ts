import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-media-cache-"));
const C = 1048576;
const pattern = (n: number, salt = 0) => Buffer.from(Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7 + salt) & 255));

// the "device": one file whose bytes we control, and counters on the RPCs
let file = pattern(3 * C + 500);
let mtimeMs = 1000;
let corrupt = -1;
let noIndex = false;
const calls = { index: 0, chunk: 0 };
vi.mock("@/lib/rpc", () => ({
  callAgent: async (_d: string, _s: string, p: { method: string; offset?: number; length?: number }) => {
    if (p.method === "media-index") {
      calls.index++;
      if (noIndex) throw new Error("unknown method");
      const leaves: string[] = [];
      for (let i = 0; i < file.length; i += C) leaves.push(createHash("sha256").update(file.subarray(i, i + C)).digest("hex"));
      return { method: "media-index", size: file.length, mtimeMs, chunk: C, leaves };
    }
    calls.chunk++;
    await new Promise((r) => setTimeout(r, 5));
    const b = Buffer.from(file.subarray(p.offset!, p.offset! + p.length!));
    if (p.offset === corrupt * C) b[0] ^= 1;
    return { method: "download-chunk", data: b.toString("base64"), eof: p.offset! + b.length >= file.length };
  },
}));
const { mediaManifest, cachedByteStream, bytesFor, cachedOnly } = await import("../media/cache");

const read = async (drive: string, start: number, end: number) => {
  const m = (await mediaManifest(drive, "s", "v.mp4", { size: file.length, mtimeMs }))!;
  return Buffer.from(await new Response(cachedByteStream(drive, "s", "v.mp4", m, start, end)).arrayBuffer());
};

beforeEach(() => { calls.index = 0; calls.chunk = 0; corrupt = -1; });

describe("verifying media cache", () => {
  it("serves a Range across chunk boundaries with the right bytes", async () => {
    const got = await read("d1", C - 10, 2 * C + 10);
    expect(got.equals(file.subarray(C - 10, 2 * C + 10))).toBe(true);
  });

  it("a second full read makes no agent calls", async () => {
    await read("d2", 0, file.length);
    calls.chunk = 0; calls.index = 0;
    const again = await read("d2", 0, file.length);
    expect(again.equals(file)).toBe(true);
    expect(calls).toEqual({ index: 0, chunk: 0 });
  });

  it("a corrupt chunk errors the stream and is not kept", async () => {
    corrupt = 1;
    await expect(read("d3", C, C + 100)).rejects.toThrow();
    corrupt = -1;
    const ok = await read("d3", C, C + 100);
    expect(ok.equals(file.subarray(C, C + 100))).toBe(true);
  });

  it("two readers of the same uncached chunk share one fetch", async () => {
    await Promise.all([read("d4", 0, 100), read("d4", 50, 200)]);
    expect(calls.chunk).toBeLessThanOrEqual(3); // chunk 0 once, plus up to 2 prefetches
    const zeroFetches = calls.chunk;
    await read("d4", 0, 10);
    expect(calls.chunk).toBe(zeroFetches);
  });

  it("a file that changed is indexed again and old chunks are not served", async () => {
    await read("d5", 0, 100);
    file = pattern(3 * C + 500, 9); mtimeMs = 2000;
    const got = await read("d5", 0, 100);
    expect(got.equals(file.subarray(0, 100))).toBe(true);
    file = pattern(3 * C + 500); mtimeMs = 1000;
  });

  it("the end of a file that is an exact multiple of 1 MiB", async () => {
    const keep = file; file = pattern(2 * C);
    const got = await read("d6", 2 * C - 5, 2 * C);
    expect(got.equals(file.subarray(2 * C - 5))).toBe(true);
    file = keep;
  });

  it("evicts least recently used chunks to stay under the budget", async () => {
    process.env.AINDRIVE_MEDIA_CACHE_MB = "2";
    await read("d7", 0, file.length);
    await new Promise((r) => setTimeout(r, 100));
    const dir = join(process.env.AINDRIVE_DATA_DIR!, "media-cache", "d7");
    let total = 0;
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); const s = statSync(p); if (s.isDirectory()) walk(p); else total += s.size; } };
    walk(dir);
    expect(total).toBeLessThanOrEqual(2 * C);
    delete process.env.AINDRIVE_MEDIA_CACHE_MB;
  });

  it("an agent without media-index is streamed the old way (bytesFor)", async () => {
    noIndex = true;
    const got = Buffer.from(await new Response(await bytesFor("d8", "s", "old.mp4", { size: file.length, mtimeMs: 1 }, 10, 2 * C)).arrayBuffer());
    expect(got.equals(file.subarray(10, 2 * C))).toBe(true);
    noIndex = false;
  });

  it("a small file skips the index entirely", async () => {
    calls.index = 0;
    const keep = file; file = pattern(1000);
    const got = Buffer.from(await new Response(await bytesFor("d9", "s", "small.txt", { size: 1000, mtimeMs: 1 }, 0, 1000)).arrayBuffer());
    expect(got.equals(file)).toBe(true);
    expect(calls.index).toBe(0);
    file = keep;
  });

  it("the device is asleep: a fully cached range still plays, an uncached one does not", async () => {
    await read("d10", 0, 10); // chunk 0, and its prefetch of chunks 1-2, are now cached; chunk 3 is not
    await new Promise((r) => setTimeout(r, 50));
    const hit = cachedOnly("d10", "v.mp4", 5, C + 5);
    expect(hit).not.toBeNull();
    const got = Buffer.from(await new Response(hit!.stream).arrayBuffer());
    expect(got.equals(file.subarray(5, C + 5))).toBe(true);
    expect(hit!.size).toBe(file.length);
    expect(cachedOnly("d10", "v.mp4", 0, file.length)).toBeNull(); // the last chunk was never fetched
    expect(cachedOnly("d10", "never-seen.mp4", 0, 10)).toBeNull();
  });
});
