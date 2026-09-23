import { describe, it, expect, beforeEach } from "vitest";
import { previewCachePath, previewTargetFor, ensureJob, _resetPreviewJobs, FAILURE_TTL_MS } from "./preview-convert";
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
  it("keys by sha1(path) + mtime under previews/<driveId>", () => {
    const p = previewCachePath("drv1", "docs/a.doc", 1700000000000, "pdf", "/data");
    expect(p).toMatch(/^\/data\/previews\/drv1\/[0-9a-f]{40}-1700000000000\.pdf$/);
  });
  it("changes with mtime and target, not with the data dir root only", () => {
    const a = previewCachePath("d", "v.avi", 1, "mp4", "/x");
    expect(previewCachePath("d", "v.avi", 2, "mp4", "/x")).not.toBe(a);
    expect(previewCachePath("d", "w.avi", 1, "mp4", "/x")).not.toBe(a);
    expect(previewCachePath("d", "v.avi", 1, "mp4", "/x")).toBe(a);
  });
  it("never lets the file path escape the drive's cache dir", () => {
    const p = previewCachePath("d", "../../etc/passwd", 1, "pdf", "/x");
    expect(p.startsWith("/x/previews/d/")).toBe(true);
    expect(p.slice("/x/previews/d/".length)).not.toContain("/");
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
});
