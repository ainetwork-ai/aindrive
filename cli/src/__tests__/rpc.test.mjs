// Unit tests for safeResolve traversal guard and isSelfWrite TTL.
import { describe, it, expect, vi, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { safeResolve, isSelfWrite, handleRpc, isReservedRpcPath } from "../rpc.js";

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

  it("a write named in NFC is recognised when the watcher reports the NFD spelling", async () => {
    // the server sends NFC; fs.watch reports the name as the disk spells it
    const tmp = mkdtempSync(path.join(tmpdir(), "aitest-nfc-"));
    try {
      await handleRpc({ method: "write", path: "메모.md".normalize("NFC"), content: "hi" }, tmp);
      expect(isSelfWrite("메모.md".normalize("NFD"))).toBe(true);
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

// ── reserved .aindrive paths ─────────────────────────────────────────────
describe("reserved .aindrive paths over RPC", () => {
  it("classifies system paths, allowing only agents/ and uploads/", () => {
    for (const p of [".aindrive", ".aindrive/config.json", ".aindrive/agent.pid", ".aindrive/willow.db", ".aindrive/yjs/x.bin"]) {
      expect(isReservedRpcPath(p), p).toBe(true);
    }
    for (const p of ["", "docs/.aindrive/config.json", ".aindrive-notes", ".aindrive/agents", ".aindrive/agents/a.json", ".aindrive/uploads/x.part"]) {
      expect(isReservedRpcPath(p), p).toBe(false);
    }
  });

  it("refuses every path-bearing method on config.json, however the path is spelled", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rpc-reserved-"));
    mkdirSync(path.join(root, ".aindrive", "agents"), { recursive: true });
    writeFileSync(path.join(root, ".aindrive", "config.json"), '{"agentToken":"secret"}');
    writeFileSync(path.join(root, "a.txt"), "x");
    for (const spelled of [".aindrive/config.json", "./.aindrive//config.json", "x/../.aindrive/config.json"]) {
      await expect(handleRpc({ method: "read", path: spelled }, root), spelled).rejects.toThrow(/reserved path/);
      await expect(handleRpc({ method: "download-chunk", path: spelled, offset: 0 }, root)).rejects.toThrow(/reserved path/);
      await expect(handleRpc({ method: "write", path: spelled, content: "{}" }, root)).rejects.toThrow(/reserved path/);
      await expect(handleRpc({ method: "delete", path: spelled }, root)).rejects.toThrow(/reserved path/);
    }
    await expect(handleRpc({ method: "list", path: ".aindrive" }, root)).rejects.toThrow(/reserved path/);
    await expect(handleRpc({ method: "rename", from: "a.txt", to: ".aindrive/config.json" }, root)).rejects.toThrow(/reserved path/);
    await expect(handleRpc({ method: "rename", from: ".aindrive/config.json", to: "leak.json" }, root)).rejects.toThrow(/reserved path/);
    expect(readFileSync(path.join(root, ".aindrive", "config.json"), "utf8")).toContain("secret");
    expect(existsSync(path.join(root, "leak.json"))).toBe(false);
    // Server-internal areas keep working.
    await handleRpc({ method: "write", path: ".aindrive/agents/a.json", content: "{}" }, root);
    expect((await handleRpc({ method: "list", path: ".aindrive/agents" }, root)).entries.map((e) => e.name)).toEqual(["a.json"]);
    await handleRpc({ method: "upload-chunk", path: ".aindrive/uploads/u.part", data: Buffer.from("hi").toString("base64"), chunkId: 0 }, root);
    rmSync(root, { recursive: true, force: true });
  });
});
