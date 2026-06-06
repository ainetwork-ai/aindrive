// Unit tests for safeResolve traversal guard and isSelfWrite TTL.
import { describe, it, expect, vi, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { safeResolve, isSelfWrite, handleRpc } from "../rpc.js";

const ROOT = "/tmp/drive-root-test";

describe("safeResolve", () => {
  it("resolves a normal relative path inside root", () => {
    const result = safeResolve(ROOT, "docs/readme.md");
    expect(result).toBe(path.join(ROOT, "docs/readme.md"));
  });

  it("resolves the empty string to root itself", () => {
    expect(safeResolve(ROOT, "")).toBe(ROOT);
  });

  it("throws on a simple traversal attempt", () => {
    expect(() => safeResolve(ROOT, "../etc/passwd")).toThrow("path escapes drive root");
  });

  it("contains an absolute path within root (prefix trick resolves it inside root)", () => {
    // path.resolve(root, "./" + "/etc/passwd") = path.resolve(root, ".//etc/passwd")
    // The double-slash is treated as relative, so the absolute path lands inside root,
    // not at /etc/passwd. This is the correct security behavior — not an escape.
    const result = safeResolve(ROOT, "/etc/passwd");
    expect(result).toBe(path.join(ROOT, "etc/passwd"));
  });

  it("throws on a traversal hidden inside subdirectory segments", () => {
    expect(() =>
      safeResolve(ROOT, "a/b/../../../../../../etc/shadow")
    ).toThrow("path escapes drive root");
  });

  it("throws on a non-string path", () => {
    expect(() => safeResolve(ROOT, null)).toThrow("invalid path");
  });

  it("throws when path exceeds 4096 bytes", () => {
    const long = "a".repeat(4097);
    expect(() => safeResolve(ROOT, long)).toThrow("path too long");
  });

  it("sibling directory with a matching prefix is rejected", () => {
    expect(() =>
      safeResolve(ROOT, "../drive-root-test-sibling/file")
    ).toThrow("path escapes drive root");
  });
});

describe("isSelfWrite", () => {
  afterEach(() => vi.useRealTimers());

  it("returns false for an unknown path", () => {
    expect(isSelfWrite("never-written.txt")).toBe(false);
  });

  it("returns true immediately after a write RPC", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "aitest-"));
    try {
      await handleRpc({ method: "write", path: "hello.txt", content: "hi" }, tmp);
      expect(isSelfWrite("hello.txt")).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns false after the 2000 ms TTL expires", async () => {
    vi.useFakeTimers();
    const tmp = mkdtempSync(path.join(tmpdir(), "aitest-ttl-"));
    try {
      // handleRpc write is async but fake timers are already installed;
      // the write itself is synchronous enough for our purposes.
      await handleRpc({ method: "write", path: "ttl.txt", content: "x" }, tmp);
      expect(isSelfWrite("ttl.txt")).toBe(true);
      vi.advanceTimersByTime(2001);
      expect(isSelfWrite("ttl.txt")).toBe(false);
    } finally {
      vi.useRealTimers();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
