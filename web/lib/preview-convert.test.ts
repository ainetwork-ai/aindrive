import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, utimes, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  previewCachePath, previewTargetFor, ensureJob, _resetPreviewJobs, _failureCount, FAILURE_TTL_MS,
  MAX_JOBS_PER_DRIVE, validAgentStat, magicMatches, evictPreviewCache, assertInside,
} from "./preview-convert";
import { parseByteRange } from "./byte-range";

describe("previewTargetFor", () => {
  it("allows pdf only for converter kinds", () => {
    for (const p of ["a.doc", "b/c.PPT", "x.key", "y.numbers", "z.pages", "f.eps", "f.ps", "f.xps", "f.rtf", "f.odt"]) {
      expect(previewTargetFor(p, "pdf"), p).toBe("pdf");
      expect(previewTargetFor(p, "mp4"), p).toBeNull();
    }
  });
  it("allows mp4 only for video and audio kinds", () => {
    for (const p of ["a.avi", "a.wmv", "a.flv", "a.3gp", "a.mpg", "a.mp4", "a.mov", "a.mpga", "a.mp2", "a.flac"]) {
      expect(previewTargetFor(p, "mp4"), p).toBe("mp4");
      expect(previewTargetFor(p, "pdf"), p).toBeNull();
    }
  });
  it("rejects everything else", () => {
    expect(previewTargetFor("a.docx", "pdf")).toBeNull(); // client-rendered
    expect(previewTargetFor("a.pdf", "pdf")).toBeNull();
    expect(previewTargetFor("a.html", "pdf")).toBeNull();
    expect(previewTargetFor("a.doc", null)).toBeNull();
    expect(previewTargetFor("a.doc", "html")).toBeNull();
  });
});

describe("previewCachePath", () => {
  it("keys by sha1(path) + mtime + size under previews/<driveId>", () => {
    const p = previewCachePath("drv1", "docs/a.doc", 1700000000000.7, 42, "pdf", "/data");
    expect(p).toMatch(/^\/data\/previews\/drv1\/[0-9a-f]{40}-1700000000000-42\.pdf$/);
  });
  it("changes with mtime, size and path", () => {
    const a = previewCachePath("d", "v.avi", 1, 10, "mp4", "/x");
    expect(previewCachePath("d", "v.avi", 2, 10, "mp4", "/x")).not.toBe(a);
    expect(previewCachePath("d", "v.avi", 1, 11, "mp4", "/x")).not.toBe(a);
    expect(previewCachePath("d", "w.avi", 1, 10, "mp4", "/x")).not.toBe(a);
    expect(previewCachePath("d", "v.avi", 1, 10, "mp4", "/x")).toBe(a);
  });
  it("rejects non-numeric stat values and escaping drive ids", () => {
    const evil = "/../../OTHER/abc-123" as unknown as number;
    expect(() => previewCachePath("d", "a.doc", evil, 1, "pdf", "/x")).toThrow();
    expect(() => previewCachePath("d", "a.doc", NaN, 1, "pdf", "/x")).toThrow();
    expect(() => previewCachePath("..", "a.doc", 1, 1, "pdf", "/x")).toThrow();
    expect(() => previewCachePath("", "a.doc", 1, 1, "pdf", "/x")).toThrow();
    expect(() => previewCachePath("a/../../b", "a.doc", 1, 1, "pdf", "/x")).toThrow();
  });
  it("never lets the file path escape the drive's cache dir", () => {
    const p = previewCachePath("d", "../../etc/passwd", 1, 1, "pdf", "/x");
    expect(p.startsWith("/x/previews/d/")).toBe(true);
    expect(p.slice("/x/previews/d/".length)).not.toContain("/");
  });
});

describe("validAgentStat", () => {
  it("accepts finite numbers and truncates mtime", () => {
    expect(validAgentStat({ mtimeMs: 1700000000000.9, size: 5 })).toEqual({ mtimeMs: 1700000000000, size: 5 });
    expect(validAgentStat({ mtimeMs: 0, size: 0 })).toEqual({ mtimeMs: 0, size: 0 });
  });
  it("rejects a malicious mtime string (path traversal) and bad sizes", () => {
    expect(validAgentStat({ mtimeMs: "/../../OTHER/abc-123", size: 1 })).toBeNull();
    expect(validAgentStat({ mtimeMs: "1700000000000", size: 1 })).toBeNull();
    expect(validAgentStat({ mtimeMs: Infinity, size: 1 })).toBeNull();
    expect(validAgentStat({ mtimeMs: 1, size: -1 })).toBeNull();
    expect(validAgentStat({ mtimeMs: 1, size: "5" })).toBeNull();
    expect(validAgentStat({ mtimeMs: 1, size: NaN })).toBeNull();
    expect(validAgentStat({})).toBeNull();
  });
  it("assertInside refuses anything outside the directory", () => {
    expect(assertInside("/x/a", "/x/a/b")).toBe("/x/a/b");
    expect(() => assertInside("/x/a", "/x/a")).toThrow();
    expect(() => assertInside("/x/a", "/x/ab")).toThrow();
    expect(() => assertInside("/x/a", "/x/a/../b")).toThrow();
  });
});

describe("magicMatches", () => {
  const bytes = (...b: number[]) => new Uint8Array(b);
  const ascii = (s: string) => new TextEncoder().encode(s);
  const OLE = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
  it("accepts real signatures", () => {
    for (const e of ["doc", "dot", "ppt", "pps", "pot"]) expect(magicMatches(e, OLE), e).toBe(true);
    for (const e of ["key", "numbers", "pages", "odt", "ott", "odp", "xps", "oxps"]) {
      expect(magicMatches(e, ascii("PK\x03\x04abcd")), e).toBe(true);
    }
    expect(magicMatches("rtf", ascii("{\\rtf1\\an"))).toBe(true);
    expect(magicMatches("ps", ascii("%!PS-Ado"))).toBe(true);
    expect(magicMatches("eps", bytes(0xc5, 0xd0, 0xd3, 0xc6, 0, 0, 0, 0))).toBe(true);
    expect(magicMatches("wpd", bytes(0xff, 0x57, 0x50, 0x43, 0, 0, 0, 0))).toBe(true);
  });
  it("rejects a PEM server.key, a Graphviz .dot and text named .doc", () => {
    expect(magicMatches("key", ascii("-----BEGIN PRIVATE KEY-----"))).toBe(false);
    expect(magicMatches("dot", ascii("digraph G {"))).toBe(false);
    expect(magicMatches("doc", ascii("hello world"))).toBe(false);
    expect(magicMatches("doc", OLE.slice(0, 4))).toBe(false); // truncated
    expect(magicMatches("rtf", OLE)).toBe(false);
  });
  it("passes types without a table entry (video/audio are probed by the sidecar)", () => {
    expect(magicMatches("avi", ascii("#EXTM3U"))).toBe(true);
  });
});

describe("evictPreviewCache", () => {
  it("deletes least-recently-used files until under the cap, never .tmp", async () => {
    const root = await mkdtemp(join(tmpdir(), "pv-"));
    await mkdir(join(root, "d1")); await mkdir(join(root, "d2"));
    const put = async (rel: string, n: number, t: number) => {
      await writeFile(join(root, rel), Buffer.alloc(n));
      await utimes(join(root, rel), t, t);
    };
    await put("d1/old.pdf", 100, 1000);
    await put("d2/mid.mp4", 100, 2000);
    await put("d1/new.pdf", 100, 3000);
    await put("d2/x.mp4.1.2.tmp", 100, 500);
    expect(await evictPreviewCache(root, 250)).toBe(2);
    expect((await readdir(join(root, "d1"))).sort()).toEqual(["new.pdf"]);
    expect(await readdir(join(root, "d2"))).toEqual(["x.mp4.1.2.tmp"]);
    expect(await evictPreviewCache(root, 1000)).toBe(0);
  });
});

describe("parseByteRange", () => {
  it("no header → whole body, not partial", () => {
    expect(parseByteRange(null, 100)).toEqual({ ok: true, start: 0, endExclusive: 100, partial: false });
  });
  it("bytes=a-b / a- / -n", () => {
    expect(parseByteRange("bytes=0-0", 100)).toEqual({ ok: true, start: 0, endExclusive: 1, partial: true });
    expect(parseByteRange("bytes=10-", 100)).toEqual({ ok: true, start: 10, endExclusive: 100, partial: true });
    expect(parseByteRange("bytes=-10", 100)).toEqual({ ok: true, start: 90, endExclusive: 100, partial: true });
    expect(parseByteRange("bytes=90-500", 100)).toEqual({ ok: true, start: 90, endExclusive: 100, partial: true });
  });
  it("malformed / unsatisfiable", () => {
    expect(parseByteRange("bytes=-", 100)).toEqual({ ok: false, error: "malformed range" });
    expect(parseByteRange("items=0-1", 100)).toEqual({ ok: false, error: "malformed range" });
    expect(parseByteRange("bytes=0-1,5-6", 100)).toEqual({ ok: false, error: "malformed range" });
    expect(parseByteRange("bytes=100-", 100)).toEqual({ ok: false, error: "range not satisfiable" });
    expect(parseByteRange("bytes=5-4", 100)).toEqual({ ok: false, error: "range not satisfiable" });
  });
});

describe("ensureJob", () => {
  beforeEach(() => _resetPreviewJobs());

  it("joins an in-flight job and remembers failures for a TTL", async () => {
    // Unroutable converter + no agent: the job fails fast, which is the path
    // we want to observe (the agent RPC rejects before any network I/O).
    const spec = {
      cachePath: `/nonexistent-${Date.now()}/x.pdf`, driveId: "no-such-drive", driveSecret: "s",
      path: "a.doc", size: 10, target: "pdf" as const, converterUrl: "http://127.0.0.1:9",
    };
    expect(ensureJob(spec)).toEqual({ state: "pending" });
    expect(ensureJob(spec)).toEqual({ state: "pending" }); // joined, not restarted
    await new Promise((r) => setTimeout(r, 200));
    const failed = ensureJob(spec);
    expect(failed.state).toBe("failed");
    // After the TTL the next request retries.
    expect(ensureJob(spec, Date.now() + FAILURE_TTL_MS + 1)).toEqual({ state: "pending" });
  });

  it("caps concurrent jobs per drive", () => {
    const mk = (i: number, driveId: string) => ({
      cachePath: `/nonexistent-${Date.now()}/${driveId}-${i}.pdf`, driveId, driveSecret: "s",
      path: `${i}.doc`, size: 10, target: "pdf" as const, converterUrl: "http://127.0.0.1:9",
    });
    for (let i = 0; i < MAX_JOBS_PER_DRIVE; i++) expect(ensureJob(mk(i, "A")).state).toBe("pending");
    expect(ensureJob(mk(99, "A"))).toEqual({ state: "busy" });
    expect(ensureJob(mk(0, "B")).state).toBe("pending"); // other drives unaffected
  });

  it("sweeps expired failures and caps the map", async () => {
    const mk = (i: number) => ({
      cachePath: `/nonexistent-${Date.now()}/f-${i}.pdf`, driveId: `drv-${i}`, driveSecret: "s",
      path: "a.doc", size: 10, target: "pdf" as const, converterUrl: "http://127.0.0.1:9",
    });
    // Let the previous test's jobs settle so their failures don't count here.
    await new Promise((r) => setTimeout(r, 200));
    _resetPreviewJobs();
    for (let i = 0; i < 3; i++) ensureJob(mk(i));
    await new Promise((r) => setTimeout(r, 200));
    expect(_failureCount()).toBe(3);
    ensureJob(mk(100), Date.now() + FAILURE_TTL_MS + 1); // sweep runs first
    expect(_failureCount()).toBe(0);
  });
});
