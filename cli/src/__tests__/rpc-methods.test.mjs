// Characterization tests for handleRpc read-side + transfer + yjs methods —
// agent-first migration safety net.
//
// These SNAPSHOT the *current* observed behaviour of rpc.js (probed by running
// each method against a real tmp drive root + real better-sqlite3, NOT an
// assumed spec) so a later refactor can be proven behaviour-preserving.
//
// Scope: the methods NOT already covered by rpc.test.mjs / rpc-dispatch.test.mjs.
//   - read, stat, list          (read-side filesystem)
//   - upload-chunk, download-chunk (chunked transfer)
//   - yjs-write, yjs-read, yjs-stats (Willow-backed doc store)
// The 4 fs-mutation methods (write/mkdir/rename/delete) are covered there and
// are NOT duplicated here. agent-ask is intentionally NOT covered — see the note
// at the bottom of this file.
//
// Every assertion below was verified against the current code by probing first;
// surprising/buggy edges are labelled "QUIRK" so a refactor can decide whether
// to preserve or fix them deliberately.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync,
} from "node:fs";
import path from "node:path";
import * as Y from "yjs";
import { handleRpc } from "../rpc.js";

// yjs-write/read emit cliTrace logs; silence them so test output stays clean.
// This only mutates THIS test process's env, never the source.
process.env.AINDRIVE_TRACE = "off";

const b64 = (s) => Buffer.from(s).toString("base64");
const fromB64 = (s) => Buffer.from(s, "base64");

let tmp;
beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), "rpc-methods-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

// ── read ──────────────────────────────────────────────────────────────────
describe("handleRpc — read", () => {
  it("reads a UTF-8 file untruncated", async () => {
    writeFileSync(path.join(tmp, "hello.txt"), "hello world");
    const r = await handleRpc({ method: "read", path: "hello.txt" }, tmp);
    expect(r).toEqual({
      method: "read", content: "hello world", encoding: "utf8", truncated: false,
    });
  });

  it("reads an empty file (content '', not truncated)", async () => {
    writeFileSync(path.join(tmp, "empty.txt"), "");
    const r = await handleRpc({ method: "read", path: "empty.txt" }, tmp);
    expect(r).toEqual({
      method: "read", content: "", encoding: "utf8", truncated: false,
    });
  });

  it("returns base64 content when encoding='base64'", async () => {
    writeFileSync(path.join(tmp, "hello.txt"), "hello world");
    const r = await handleRpc({ method: "read", path: "hello.txt", encoding: "base64" }, tmp);
    expect(r).toEqual({
      method: "read", content: b64("hello world"), encoding: "base64", truncated: false,
    });
  });

  it("any non-base64 encoding value falls back to utf8", async () => {
    writeFileSync(path.join(tmp, "hello.txt"), "abc");
    const r = await handleRpc({ method: "read", path: "hello.txt", encoding: "latin1" }, tmp);
    expect(r.encoding).toBe("utf8");
    expect(r.content).toBe("abc");
  });

  it("truncates to maxBytes and reports truncated=true", async () => {
    writeFileSync(path.join(tmp, "big.txt"), "0123456789");
    const r = await handleRpc({ method: "read", path: "big.txt", maxBytes: 4 }, tmp);
    expect(r).toEqual({
      method: "read", content: "0123", encoding: "utf8", truncated: true,
    });
  });

  it("QUIRK maxBytes=0 yields empty content but truncated=true (size > 0)", async () => {
    // truncated is `st.size > buf.length`; buf.length is 0 here, file is 10 bytes.
    writeFileSync(path.join(tmp, "big.txt"), "0123456789");
    const r = await handleRpc({ method: "read", path: "big.txt", maxBytes: 0 }, tmp);
    expect(r).toEqual({
      method: "read", content: "", encoding: "utf8", truncated: true,
    });
  });

  it("maxBytes larger than the file does not truncate", async () => {
    writeFileSync(path.join(tmp, "hello.txt"), "hello world");
    const r = await handleRpc({ method: "read", path: "hello.txt", maxBytes: 9_999_999 }, tmp);
    expect(r.truncated).toBe(false);
    expect(r.content).toBe("hello world");
  });

  it("throws 'is a directory' when reading a directory", async () => {
    mkdirSync(path.join(tmp, "adir"));
    await expect(handleRpc({ method: "read", path: "adir" }, tmp))
      .rejects.toThrow("is a directory");
  });

  it("rejects a missing file with ENOENT (the raw fs error, not a wrapped message)", async () => {
    await expect(handleRpc({ method: "read", path: "nope.txt" }, tmp))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a traversal path before touching the filesystem", async () => {
    await expect(handleRpc({ method: "read", path: "../x" }, tmp))
      .rejects.toThrow("path escapes drive root");
  });

  it("rejects a missing path arg via safeResolve ('invalid path')", async () => {
    await expect(handleRpc({ method: "read" }, tmp))
      .rejects.toThrow("invalid path");
  });
});

// ── stat ──────────────────────────────────────────────────────────────────
describe("handleRpc — stat", () => {
  it("returns the full entry shape for a file", async () => {
    writeFileSync(path.join(tmp, "doc.md"), "# title");
    const r = await handleRpc({ method: "stat", path: "doc.md" }, tmp);
    expect(r.method).toBe("stat");
    expect(r.entry).toMatchObject({
      name: "doc.md", path: "doc.md", isDir: false, size: 7,
      ext: "md", mime: "text/markdown",
    });
    expect(typeof r.entry.mtimeMs).toBe("number");
    expect(Object.keys(r.entry).sort())
      .toEqual(["ext", "isDir", "mime", "mtimeMs", "name", "path", "size"]);
  });

  it("reports a directory with mime='folder' and empty ext", async () => {
    mkdirSync(path.join(tmp, "folder"));
    const r = await handleRpc({ method: "stat", path: "folder" }, tmp);
    expect(r.entry).toMatchObject({
      name: "folder", path: "folder", isDir: true, ext: "", mime: "folder",
    });
  });

  it("returns entry=null for a missing path (does NOT throw)", async () => {
    const r = await handleRpc({ method: "stat", path: "nope" }, tmp);
    expect(r).toEqual({ method: "stat", entry: null });
  });

  it("stats the drive root itself for path='' (name=root basename, path='')", async () => {
    const r = await handleRpc({ method: "stat", path: "" }, tmp);
    expect(r.entry).toMatchObject({
      name: path.basename(tmp), path: "", isDir: true, mime: "folder",
    });
  });

  it("throws on a traversal path (safeResolve runs before the try/catch)", async () => {
    await expect(handleRpc({ method: "stat", path: "../x" }, tmp))
      .rejects.toThrow("path escapes drive root");
  });

  it("QUIRK missing path arg throws 'invalid path' (not entry=null)", async () => {
    // safeResolve(root, undefined) throws before the try/catch that would null.
    await expect(handleRpc({ method: "stat" }, tmp))
      .rejects.toThrow("invalid path");
  });
});

// ── list ──────────────────────────────────────────────────────────────────
describe("handleRpc — list", () => {
  it("lists directories first then files, alphabetical within each group", async () => {
    writeFileSync(path.join(tmp, "b.txt"), "b");
    writeFileSync(path.join(tmp, "a.txt"), "a");
    mkdirSync(path.join(tmp, "zdir"));
    mkdirSync(path.join(tmp, "adir"));
    const r = await handleRpc({ method: "list", path: "" }, tmp);
    expect(r.method).toBe("list");
    expect(r.entries.map((e) => e.name)).toEqual(["adir", "zdir", "a.txt", "b.txt"]);
    expect(r.entries.map((e) => e.isDir)).toEqual([true, true, false, false]);
  });

  it("each entry carries the full toEntry shape", async () => {
    writeFileSync(path.join(tmp, "a.txt"), "a");
    const r = await handleRpc({ method: "list", path: "" }, tmp);
    expect(Object.keys(r.entries[0]).sort())
      .toEqual(["ext", "isDir", "mime", "mtimeMs", "name", "path", "size"]);
  });

  it("hides exactly .aindrive / .DS_Store / .git but shows other dotfiles", async () => {
    writeFileSync(path.join(tmp, ".DS_Store"), "x");
    mkdirSync(path.join(tmp, ".git"));
    mkdirSync(path.join(tmp, ".aindrive"));
    writeFileSync(path.join(tmp, ".hiddencustom"), "x"); // NOT in HIDDEN set
    writeFileSync(path.join(tmp, "visible.txt"), "x");
    const r = await handleRpc({ method: "list", path: "" }, tmp);
    expect(r.entries.map((e) => e.name).sort())
      .toEqual([".hiddencustom", "visible.txt"]);
  });

  it("lists a subdirectory and reports nested paths with forward slashes", async () => {
    mkdirSync(path.join(tmp, "sub"));
    writeFileSync(path.join(tmp, "sub", "inner.txt"), "i");
    const r = await handleRpc({ method: "list", path: "sub" }, tmp);
    expect(r.entries.map((e) => e.path)).toEqual(["sub/inner.txt"]);
  });

  it("missing path arg lists the root (params.path || '')", async () => {
    writeFileSync(path.join(tmp, "a.txt"), "a");
    const r = await handleRpc({ method: "list" }, tmp);
    expect(r.entries.map((e) => e.name)).toEqual(["a.txt"]);
  });

  it("returns an empty list for an empty directory", async () => {
    const r = await handleRpc({ method: "list", path: "" }, tmp);
    expect(r).toEqual({ method: "list", entries: [] });
  });

  it("rejects listing a file with ENOTDIR", async () => {
    writeFileSync(path.join(tmp, "a.txt"), "a");
    await expect(handleRpc({ method: "list", path: "a.txt" }, tmp))
      .rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("rejects listing a missing directory with ENOENT", async () => {
    await expect(handleRpc({ method: "list", path: "nope" }, tmp))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a traversal path", async () => {
    await expect(handleRpc({ method: "list", path: "../" }, tmp))
      .rejects.toThrow("path escapes drive root");
  });
});

// ── upload-chunk ────────────────────────────────────────────────────────────
describe("handleRpc — upload-chunk", () => {
  it("chunkId 0 creates/truncates the file (mode 'w')", async () => {
    const r = await handleRpc({ method: "upload-chunk", path: "up.bin", data: b64("AAA"), chunkId: 0 }, tmp);
    expect(r).toEqual({ method: "upload-chunk", ok: true, receivedBytes: 3 });
    expect(readFileSync(path.join(tmp, "up.bin"), "utf8")).toBe("AAA");
  });

  it("a nonzero chunkId appends (mode 'a')", async () => {
    await handleRpc({ method: "upload-chunk", path: "up.bin", data: b64("AAA"), chunkId: 0 }, tmp);
    await handleRpc({ method: "upload-chunk", path: "up.bin", data: b64("BBB"), chunkId: 1 }, tmp);
    expect(readFileSync(path.join(tmp, "up.bin"), "utf8")).toBe("AAABBB");
  });

  it("a later chunkId 0 truncates again (resets the file)", async () => {
    await handleRpc({ method: "upload-chunk", path: "up.bin", data: b64("AAABBB"), chunkId: 1 }, tmp);
    await handleRpc({ method: "upload-chunk", path: "up.bin", data: b64("ZZ"), chunkId: 0 }, tmp);
    expect(readFileSync(path.join(tmp, "up.bin"), "utf8")).toBe("ZZ");
  });

  it("QUIRK chunkId undefined is treated as append (only ===0 truncates)", async () => {
    // Appends to a not-yet-existing file → the 'a' mode creates it.
    await handleRpc({ method: "upload-chunk", path: "up2.bin", data: b64("X"), chunkId: undefined }, tmp);
    expect(readFileSync(path.join(tmp, "up2.bin"), "utf8")).toBe("X");
  });

  it("creates intermediate directories", async () => {
    await handleRpc({ method: "upload-chunk", path: "deep/dir/f.bin", data: b64("D"), chunkId: 0 }, tmp);
    expect(readFileSync(path.join(tmp, "deep/dir/f.bin"), "utf8")).toBe("D");
  });

  it("receivedBytes is the decoded byte length", async () => {
    const r = await handleRpc({ method: "upload-chunk", path: "r.bin", data: b64("hello"), chunkId: 0 }, tmp);
    expect(r.receivedBytes).toBe(5);
  });

  it("accepts a chunk of exactly the 4 MiB limit", async () => {
    const exact = Buffer.alloc(4 * 1024 * 1024).toString("base64");
    const r = await handleRpc({ method: "upload-chunk", path: "exact.bin", data: exact, chunkId: 0 }, tmp);
    expect(r).toEqual({ method: "upload-chunk", ok: true, receivedBytes: 4 * 1024 * 1024 });
  });

  it("rejects a chunk one byte over the 4 MiB limit", async () => {
    const big = Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64");
    await expect(handleRpc({ method: "upload-chunk", path: "toobig.bin", data: big, chunkId: 0 }, tmp))
      .rejects.toThrow("chunk too large");
  });

  it("rejects a traversal path", async () => {
    await expect(handleRpc({ method: "upload-chunk", path: "../x", data: b64("a"), chunkId: 0 }, tmp))
      .rejects.toThrow("path escapes drive root");
  });
});

// ── download-chunk ──────────────────────────────────────────────────────────
describe("handleRpc — download-chunk", () => {
  beforeEach(() => writeFileSync(path.join(tmp, "f.txt"), "0123456789")); // 10 bytes

  it("reads length bytes from offset with eof=false mid-file", async () => {
    const r = await handleRpc({ method: "download-chunk", path: "f.txt", offset: 0, length: 4 }, tmp);
    expect(fromB64(r.data).toString()).toBe("0123");
    expect(r.eof).toBe(false);
  });

  it("reads from a mid offset", async () => {
    const r = await handleRpc({ method: "download-chunk", path: "f.txt", offset: 4, length: 4 }, tmp);
    expect(fromB64(r.data).toString()).toBe("4567");
    expect(r.eof).toBe(false);
  });

  it("a final short read (offset+length past EOF) returns the tail and eof=true", async () => {
    const r = await handleRpc({ method: "download-chunk", path: "f.txt", offset: 8, length: 4 }, tmp);
    expect(fromB64(r.data).toString()).toBe("89");
    expect(r.eof).toBe(true);
  });

  it("a read that lands exactly on EOF reports eof=true (offset+bytesRead === size)", async () => {
    const r = await handleRpc({ method: "download-chunk", path: "f.txt", offset: 6, length: 4 }, tmp);
    expect(fromB64(r.data).toString()).toBe("6789");
    expect(r.eof).toBe(true);
  });

  it("reading at EOF returns empty data and eof=true", async () => {
    const r = await handleRpc({ method: "download-chunk", path: "f.txt", offset: 10, length: 4 }, tmp);
    expect(r.data).toBe("");
    expect(r.eof).toBe(true);
  });

  it("reading past EOF returns empty data and eof=true", async () => {
    const r = await handleRpc({ method: "download-chunk", path: "f.txt", offset: 50, length: 4 }, tmp);
    expect(r.data).toBe("");
    expect(r.eof).toBe(true);
  });

  it("length defaults to the 4 MiB cap when omitted (reads whole small file)", async () => {
    const r = await handleRpc({ method: "download-chunk", path: "f.txt", offset: 0 }, tmp);
    expect(fromB64(r.data).toString()).toBe("0123456789");
    expect(r.eof).toBe(true);
  });

  it("length is capped at 4 MiB", async () => {
    const r = await handleRpc({ method: "download-chunk", path: "f.txt", offset: 0, length: 99_999_999 }, tmp);
    expect(fromB64(r.data).toString()).toBe("0123456789");
    expect(r.eof).toBe(true);
  });

  it("QUIRK offset undefined reads from position 0 but eof is always false (NaN math)", async () => {
    // params.offset is undefined → fh.read(...,undefined) reads from current pos (0),
    // but eof = `undefined + bytesRead >= size` = `NaN >= size` = false. So even a
    // whole-file read reports eof=false when offset is omitted.
    const r = await handleRpc({ method: "download-chunk", path: "f.txt", length: 4 }, tmp);
    expect(fromB64(r.data).toString()).toBe("0123");
    expect(r.eof).toBe(false);
  });

  it("rejects a missing file with ENOENT", async () => {
    await expect(handleRpc({ method: "download-chunk", path: "nope.txt", offset: 0, length: 4 }, tmp))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a traversal path", async () => {
    await expect(handleRpc({ method: "download-chunk", path: "../x", offset: 0, length: 4 }, tmp))
      .rejects.toThrow("path escapes drive root");
  });
});

// ── yjs-write / yjs-read / yjs-stats ────────────────────────────────────────
// Uses real Y.js docs + real better-sqlite3-backed Willow mirror, no mocks.
describe("handleRpc — yjs-write", () => {
  it("appends to the Willow store, writes a .bin snapshot, returns {ok,bytes,seq,digest}", async () => {
    const doc = new Y.Doc();
    doc.getArray("items").push(["a", "b", "c"]);
    const update = Y.encodeStateAsUpdate(doc);

    const r = await handleRpc({ method: "yjs-write", docId: "mydoc123", data: Buffer.from(update).toString("base64") }, tmp);
    expect(r).toMatchObject({ method: "yjs-write", ok: true, bytes: update.length, seq: 1 });
    expect(typeof r.digest).toBe("string");
    expect(r.digest.length).toBe(43); // sha256 base64url
    expect(existsSync(path.join(tmp, ".aindrive", "yjs", "mydoc123.bin"))).toBe(true);
  });

  it("assigns monotonic per-doc seq across successive writes", async () => {
    const r1 = await handleRpc({ method: "yjs-write", docId: "seqdoc12", data: b64("x") }, tmp);
    const r2 = await handleRpc({ method: "yjs-write", docId: "seqdoc12", data: b64("y") }, tmp);
    expect([r1.seq, r2.seq]).toEqual([1, 2]);
  });

  it("rejects an invalid docId (too short / bad chars / empty)", async () => {
    for (const docId of ["short", "has spaces!!", ""]) {
      await expect(handleRpc({ method: "yjs-write", docId, data: b64("x") }, tmp))
        .rejects.toThrow("invalid docId");
    }
  });

  it("rejects a blob over 16 MiB (4 × maxUploadChunkBytes)", async () => {
    const big = Buffer.alloc(16 * 1024 * 1024 + 1).toString("base64");
    await expect(handleRpc({ method: "yjs-write", docId: "bigdoc01", data: big }, tmp))
      .rejects.toThrow("yjs blob too large");
  });
});

describe("handleRpc — yjs-read", () => {
  it("round-trips a single write through the Willow replay path", async () => {
    const doc = new Y.Doc();
    doc.getArray("items").push(["a", "b", "c"]);
    const update = Y.encodeStateAsUpdate(doc);
    await handleRpc({ method: "yjs-write", docId: "rtdoc123", data: Buffer.from(update).toString("base64") }, tmp);

    const r = await handleRpc({ method: "yjs-read", docId: "rtdoc123" }, tmp);
    expect(r.method).toBe("yjs-read");
    expect(r.bytes).toBeGreaterThan(0);
    const replay = new Y.Doc();
    Y.applyUpdate(replay, new Uint8Array(fromB64(r.data)));
    expect(replay.getArray("items").toArray()).toEqual(["a", "b", "c"]);
  });

  it("merges multiple incremental writes via replay into one state", async () => {
    const doc = new Y.Doc();
    const arr = doc.getArray("items");
    let u1, u2;
    doc.once("update", (u) => { u1 = u; });
    arr.push(["one"]);
    doc.once("update", (u) => { u2 = u; });
    arr.push(["two"]);
    await handleRpc({ method: "yjs-write", docId: "mergedoc", data: Buffer.from(u1).toString("base64") }, tmp);
    await handleRpc({ method: "yjs-write", docId: "mergedoc", data: Buffer.from(u2).toString("base64") }, tmp);

    const r = await handleRpc({ method: "yjs-read", docId: "mergedoc" }, tmp);
    const replay = new Y.Doc();
    Y.applyUpdate(replay, new Uint8Array(fromB64(r.data)));
    expect(replay.getArray("items").toArray()).toEqual(["one", "two"]);
  });

  it("returns empty data/bytes for an unknown doc (no entries, no .bin)", async () => {
    const r = await handleRpc({ method: "yjs-read", docId: "unknown999" }, tmp);
    expect(r).toEqual({ method: "yjs-read", data: "", bytes: 0 });
  });

  it("falls back to the legacy .bin snapshot when no Willow entries exist", async () => {
    const yjsDir = path.join(tmp, ".aindrive", "yjs");
    mkdirSync(yjsDir, { recursive: true });
    const raw = Buffer.from([1, 2, 3, 4, 5]);
    writeFileSync(path.join(yjsDir, "legacyd01.bin"), raw);
    const r = await handleRpc({ method: "yjs-read", docId: "legacyd01" }, tmp);
    expect(r).toEqual({ method: "yjs-read", data: raw.toString("base64"), bytes: 5 });
  });

  it("rejects an invalid docId", async () => {
    await expect(handleRpc({ method: "yjs-read", docId: "x" }, tmp))
      .rejects.toThrow("invalid docId");
  });
});

describe("handleRpc — yjs-stats", () => {
  it("aggregates count / payload bytes / last_seq / last_at for a populated doc", async () => {
    await handleRpc({ method: "yjs-write", docId: "statdoc1", data: b64("x") }, tmp);
    const r = await handleRpc({ method: "yjs-stats", docId: "statdoc1" }, tmp);
    expect(r.method).toBe("yjs-stats");
    expect(r.count).toBe(1);
    expect(r.bytes).toBe(1);
    expect(r.last_seq).toBe(1);
    expect(typeof r.last_at).toBe("number");
  });

  it("returns the empty-doc SQL-null contract (count 0, others null)", async () => {
    const r = await handleRpc({ method: "yjs-stats", docId: "emptydoc1" }, tmp);
    expect(r).toEqual({
      method: "yjs-stats", count: 0, bytes: null, last_seq: null, last_at: null,
    });
  });

  it("rejects an invalid docId", async () => {
    await expect(handleRpc({ method: "yjs-stats", docId: "" }, tmp))
      .rejects.toThrow("invalid docId");
  });
});

// agent-ask is NOT covered here: its handler calls runAgentAsk(), which builds a
// real LLM client + KB and would need network/API-key/model injection to run
// deterministically. The task brief says to SKIP it rather than hack a fake in
// (which would require a source change to rpc.js to make the factory injectable).
