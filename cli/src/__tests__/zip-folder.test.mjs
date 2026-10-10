// zip-folder.js: the archive a "Download folder" produces must open in any zip
// reader, carry UTF-8 names, nested and empty folders, and leave out exactly
// what a drive listing hides plus the caller's exclusions.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import path from "node:path";
import { zipFolder, planFolder, crc32, ZipLimitError } from "../zip-folder.js";
import { handleRpc } from "../rpc.js";

let tmp;
beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), "zip-folder-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const w = (rel, content = rel) => { mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); writeFileSync(path.join(tmp, rel), content); };

/** Minimal independent reader: walks the central directory, inflates each entry, checks its CRC. */
function readZip(file) {
  const buf = readFileSync(file);
  // End record: last 22 bytes (no comment written).
  const end = buf.length - 22;
  expect(buf.readUInt32LE(end)).toBe(0x06054b50);
  const count = buf.readUInt16LE(end + 10);
  const cdSize = buf.readUInt32LE(end + 12);
  let p = buf.readUInt32LE(end + 16);
  expect(p + cdSize).toBe(end);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const extAttrs = buf.readUInt32LE(p + 38);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    expect(flags & 0x0800).toBe(0x0800); // UTF-8 names
    // local header → data
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    const lNameLen = buf.readUInt16LE(local + 26), lExtraLen = buf.readUInt16LE(local + 28);
    const dataStart = local + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + csize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    expect(data.length).toBe(usize);
    expect(crc32(data)).toBe(crc);
    // data descriptor right after the data
    expect(buf.readUInt32LE(dataStart + csize)).toBe(0x08074b50);
    expect(buf.readUInt32LE(dataStart + csize + 4)).toBe(crc);
    entries.set(name, { data, isDir: name.endsWith("/"), mode: extAttrs >>> 16 });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Python's zipfile as a second, independent reader (`unzip -t` is not installed here). */
function pythonCheck(file) {
  const py = spawnSync("python3", ["-I", "-c", [
    "import sys, zipfile, json",
    "z = zipfile.ZipFile(sys.argv[1])",
    "bad = z.testzip()",
    "print(json.dumps({'bad': bad, 'names': z.namelist(), 'sizes': {i.filename: i.file_size for i in z.infolist()}}))",
  ].join("\n"), file], { encoding: "utf8" });
  if (py.error || py.status !== 0) return null; // no python here: the JS reader above still ran
  return JSON.parse(py.stdout);
}

describe("crc32", () => {
  it("matches the reference value for 'The quick brown fox…'", () => {
    expect(crc32(Buffer.from("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
  it("is chainable across chunks", () => {
    const a = Buffer.from("hello "), b = Buffer.from("world");
    expect(crc32(b, crc32(a))).toBe(crc32(Buffer.concat([a, b])));
  });
});

describe("zipFolder", () => {
  it("round-trips nested files, UTF-8 names and empty folders", async () => {
    w("docs/readme.md", "# hi\n".repeat(100));
    w("docs/deep/er/file.txt", "deep");
    w("한글 폴더/이미지 설명.txt", "안녕하세요");
    w("emoji 🎉.txt", "party");
    w("empty.bin", "");
    mkdirSync(path.join(tmp, "vacant"));
    mkdirSync(path.join(tmp, "docs/also-vacant"));
    const out = path.join(tmp, ".aindrive/uploads/zip/t.zip");

    const r = await zipFolder(tmp, out);
    expect(r.files).toBe(5);
    expect(r.skipped).toBe(0);
    expect(r.bytes).toBe(500 + 4 + Buffer.byteLength("안녕하세요") + 5 + 0);
    expect(r.size).toBe(readFileSync(out).length);

    const z = readZip(out);
    expect([...z.keys()].sort()).toEqual([
      "docs/also-vacant/", "docs/deep/er/file.txt", "docs/readme.md", "emoji 🎉.txt", "empty.bin", "vacant/", "한글 폴더/이미지 설명.txt",
    ].sort());
    expect(z.get("docs/readme.md").data.toString()).toBe("# hi\n".repeat(100));
    expect(z.get("한글 폴더/이미지 설명.txt").data.toString()).toBe("안녕하세요");
    expect(z.get("empty.bin").data.length).toBe(0);
    expect(z.get("vacant/").isDir).toBe(true);
    expect(z.get("docs/readme.md").mode & 0o170000).toBe(0o100000); // regular file

    const py = pythonCheck(out);
    if (py) {
      expect(py.bad).toBeNull(); // every CRC verified by zipfile
      expect(py.names.sort()).toEqual([...z.keys()].sort());
      expect(py.sizes["docs/readme.md"]).toBe(500);
    }
  });

  it("skips .aindrive, .git, bare *.git remotes, node_modules, .DS_Store and symlinks", async () => {
    w("app/src/index.js", "x");
    w("app/.git/HEAD", "ref: refs/heads/main");
    w("app/node_modules/dep/index.js", "y");
    w("app/.DS_Store", "junk");
    w("repositories/site/index.html", "<html>");
    w("repositories/site.git/HEAD", "ref");
    w("repositories/site.git/objects/x", "o");
    w(".aindrive/config.json", "{}");
    w(".aindrive/uploads/zip/old.zip", "zz");
    symlinkSync("/etc", path.join(tmp, "link-out"));
    const out = path.join(tmp, ".aindrive/uploads/zip/t.zip");
    const r = await zipFolder(tmp, out);
    expect([...readZip(out).keys()].sort()).toEqual(["app/src/index.js", "repositories/site/index.html"]);
    expect(r.files).toBe(2);
  });

  it("zipping a repo working copy itself includes the working tree only", async () => {
    w("repositories/clef/.git/HEAD", "ref: refs/heads/main");
    w("repositories/clef/.git/objects/ab/cd", "blob");
    w("repositories/clef/README.md", "# clef");
    w("repositories/clef/src/main.py", "print(1)");
    const out = path.join(tmp, ".aindrive/uploads/zip/t.zip");
    await zipFolder(path.join(tmp, "repositories/clef"), out);
    expect([...readZip(out).keys()].sort()).toEqual(["README.md", "src/main.py"]);
  });

  it("leaves out excluded paths and their subtrees, counting them as skipped", async () => {
    w("free/a.txt"); w("paid/x.png"); w("paid/sub/y.png"); w("one.pdf"); w("other.pdf");
    const out = path.join(tmp, ".aindrive/uploads/zip/t.zip");
    const r = await zipFolder(tmp, out, { exclude: ["paid", "one.pdf", "/trailing/"] });
    expect([...readZip(out).keys()].sort()).toEqual(["free/a.txt", "other.pdf"]);
    expect(r.skipped).toBe(2); // the `paid` subtree once, `one.pdf` once
  });

  it("refuses more than maxFiles / maxBytes before writing anything, and the out file does not linger", async () => {
    for (let i = 0; i < 5; i++) w(`f${i}.txt`, "0123456789");
    const out = path.join(tmp, ".aindrive/uploads/zip/t.zip");
    await expect(zipFolder(tmp, out, { maxFiles: 4 })).rejects.toBeInstanceOf(ZipLimitError);
    await expect(zipFolder(tmp, out, { maxBytes: 49 })).rejects.toThrow(/zip limit/);
    expect(existsSync(out)).toBe(false);
    await expect(planFolder(tmp, { maxFiles: 5, maxBytes: 50 })).resolves.toMatchObject({ bytes: 50, skipped: 0 });
  });
});

describe("handleRpc — zip-folder", () => {
  it("zips a drive folder into the zip temp dir and reports size/files/bytes/skipped", async () => {
    w("photos/a.jpg", "JPEG"); w("photos/b.jpg", "JPEG2"); w("photos/.git/HEAD", "x");
    const r = await handleRpc({ method: "zip-folder", path: "photos", out: ".aindrive/uploads/zip/abc.zip", exclude: ["b.jpg"] }, tmp);
    expect(r).toMatchObject({ method: "zip-folder", ok: true, files: 1, bytes: 4, skipped: 1 });
    const out = path.join(tmp, ".aindrive/uploads/zip/abc.zip");
    expect(r.size).toBe(readFileSync(out).length);
    expect([...readZip(out).keys()]).toEqual(["a.jpg"]);
    // The web drains it with download-chunk and deletes it — both must reach the temp dir.
    const chunk = await handleRpc({ method: "download-chunk", path: ".aindrive/uploads/zip/abc.zip", offset: 0, length: 1 << 20 }, tmp);
    expect(Buffer.from(chunk.data, "base64").length).toBe(r.size);
    await handleRpc({ method: "delete", path: ".aindrive/uploads/zip/abc.zip" }, tmp);
    expect(existsSync(out)).toBe(false);
  });

  it("refuses a file path, an out path outside the zip temp dir, and the reserved subtree", async () => {
    w("file.txt");
    await expect(handleRpc({ method: "zip-folder", path: "file.txt", out: ".aindrive/uploads/zip/a.zip" }, tmp)).rejects.toThrow("not a directory");
    await expect(handleRpc({ method: "zip-folder", path: "", out: "evil.zip" }, tmp)).rejects.toThrow(/zip output must be under/);
    await expect(handleRpc({ method: "zip-folder", path: "", out: ".aindrive/uploads/git/a.zip" }, tmp)).rejects.toThrow(/zip output must be under/);
    await expect(handleRpc({ method: "zip-folder", path: ".aindrive", out: ".aindrive/uploads/zip/a.zip" }, tmp)).rejects.toThrow("reserved path");
  });

  it("surfaces a cap as a 'zip limit' error", async () => {
    const { ZIP_LIMITS } = await import("../zip-folder.js");
    const saved = ZIP_LIMITS.maxFiles;
    ZIP_LIMITS.maxFiles = 1;
    try {
      w("a.txt"); w("b.txt");
      await expect(handleRpc({ method: "zip-folder", path: "", out: ".aindrive/uploads/zip/a.zip" }, tmp)).rejects.toThrow(/^zip limit:/);
    } finally { ZIP_LIMITS.maxFiles = saved; }
  });
});
