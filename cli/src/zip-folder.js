// Folder → .zip on the agent, for the web's "Download folder" (fs/download-folder).
//
// Dependency-free on purpose: the CLI ships two native deps and nothing else,
// and a zip needs only zlib (deflate-raw) and a CRC-32. The writer streams one
// file at a time into the output, so memory stays flat however big the folder.
//
// Format (PKWARE APPNOTE 6.3.x, no ZIP64 — the byte cap keeps every count and
// offset under 4 GiB): each entry is a local header (bit 3 set: sizes and CRC
// follow in a data descriptor, so a file is read exactly once), the deflated
// bytes, a data descriptor; then the central directory and the end record.
// Names are UTF-8 with bit 11 set, '/'-separated, folders end in '/'.
import { promises as fsp, createReadStream, createWriteStream } from "node:fs";
import { createDeflateRaw, constants as zc } from "node:zlib";
import path from "node:path";

/** Names never archived, at any depth: aindrive's own state, git internals, installs, Finder junk. */
export const ZIP_SKIP_NAMES = new Set([".aindrive", ".git", "node_modules", ".DS_Store"]);
/** A bare git remote (`<repo>.git`, cli/src/rpc.js _isBareName) — git's, not the user's. */
const isBareName = (name) => name.endsWith(".git") && name.length > 4;

export const ZIP_LIMITS = {
  maxFiles: 20_000,
  maxBytes: 2 * 1024 * 1024 * 1024, // 2 GiB of input
  timeoutMs: 10 * 60 * 1000,
};

/** Thrown when a cap is exceeded; the web turns it into a 413. */
export class ZipLimitError extends Error {
  constructor(msg) { super("zip limit: " + msg); this.name = "ZipLimitError"; }
}

// ---- CRC-32 (IEEE 802.3, as zip uses) ----
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
export function crc32(buf, crc = 0) {
  let c = ~crc;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// ---- MS-DOS date/time, as zip headers store mtime ----
function dosDateTime(ms) {
  const d = new Date(ms);
  let year = d.getFullYear();
  if (year < 1980) return { date: (1 << 5) | 1, time: 0 }; // 1980-01-01 00:00
  if (year > 2107) year = 2107;
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { date, time };
}

const SIG_LOCAL = 0x04034b50, SIG_DESC = 0x08074b50, SIG_CENTRAL = 0x02014b50, SIG_END = 0x06054b50;
const VERSION_MADE_BY = (3 << 8) | 20; // UNIX, 2.0
const VERSION_NEEDED = 20;
const FLAG_DESCRIPTOR = 0x0008, FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0, METHOD_DEFLATE = 8;

/**
 * Writes one zip to `outStream` (a Writable). Call addFile/addDirectory in any
 * order, then finalize(). Every method awaits the stream, so backpressure holds.
 */
export class ZipWriter {
  constructor(outStream) {
    this.out = outStream;
    this.offset = 0;
    this.entries = [];
  }

  _write(buf) {
    return new Promise((resolve, reject) => {
      this.offset += buf.length;
      this.out.write(buf, (err) => (err ? reject(err) : resolve()));
    });
  }

  _localHeader(nameBuf, { method, mtimeMs }) {
    const { date, time } = dosDateTime(mtimeMs);
    const h = Buffer.alloc(30 + nameBuf.length);
    h.writeUInt32LE(SIG_LOCAL, 0);
    h.writeUInt16LE(VERSION_NEEDED, 4);
    h.writeUInt16LE(FLAG_DESCRIPTOR | FLAG_UTF8, 6);
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    // crc / sizes: 0 here, real values in the data descriptor and the central directory.
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(0, 28);
    nameBuf.copy(h, 30);
    return h;
  }

  _descriptor(crc, csize, usize) {
    const d = Buffer.alloc(16);
    d.writeUInt32LE(SIG_DESC, 0);
    d.writeUInt32LE(crc, 4);
    d.writeUInt32LE(csize, 8);
    d.writeUInt32LE(usize, 12);
    return d;
  }

  /** An empty folder entry (`name` without the trailing slash). */
  async addDirectory(name, mtimeMs = Date.now()) {
    const nameBuf = Buffer.from(name.replace(/\/+$/, "") + "/", "utf8");
    const offset = this.offset;
    await this._write(this._localHeader(nameBuf, { method: METHOD_STORE, mtimeMs }));
    await this._write(this._descriptor(0, 0, 0));
    this.entries.push({ nameBuf, method: METHOD_STORE, mtimeMs, crc: 0, csize: 0, usize: 0, offset, mode: 0o40755, isDir: true });
  }

  /** A file: streams `absPath` through deflate-raw. */
  async addFile(name, absPath, { mtimeMs, mode = 0o100644, signal } = {}) {
    const nameBuf = Buffer.from(name, "utf8");
    const offset = this.offset;
    await this._write(this._localHeader(nameBuf, { method: METHOD_DEFLATE, mtimeMs }));
    let crc = 0, usize = 0, csize = 0;
    const deflate = createDeflateRaw({ level: zc.Z_DEFAULT_COMPRESSION });
    const src = createReadStream(absPath, { signal });
    const self = this;
    await new Promise((resolve, reject) => {
      let pending = Promise.resolve();
      const fail = (e) => { src.destroy(); deflate.destroy(); reject(e); };
      src.on("error", fail);
      deflate.on("error", fail);
      src.on("data", (chunk) => { crc = crc32(chunk, crc); usize += chunk.length; });
      deflate.on("data", (chunk) => {
        csize += chunk.length;
        deflate.pause();
        pending = pending.then(() => self._write(chunk)).then(() => deflate.resume(), fail);
      });
      deflate.on("end", () => { pending.then(resolve, fail); });
      src.pipe(deflate);
    });
    await this._write(this._descriptor(crc, csize, usize));
    this.entries.push({ nameBuf, method: METHOD_DEFLATE, mtimeMs, crc, csize, usize, offset, mode, isDir: false });
    return { usize, csize };
  }

  /** Central directory + end record. Resolves once the stream has finished. */
  async finalize() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const { date, time } = dosDateTime(e.mtimeMs);
      const h = Buffer.alloc(46 + e.nameBuf.length);
      h.writeUInt32LE(SIG_CENTRAL, 0);
      h.writeUInt16LE(VERSION_MADE_BY, 4);
      h.writeUInt16LE(VERSION_NEEDED, 6);
      h.writeUInt16LE(FLAG_DESCRIPTOR | FLAG_UTF8, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(time, 12);
      h.writeUInt16LE(date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.csize, 20);
      h.writeUInt32LE(e.usize, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt16LE(0, 30); // extra
      h.writeUInt16LE(0, 32); // comment
      h.writeUInt16LE(0, 34); // disk
      h.writeUInt16LE(0, 36); // internal attrs
      h.writeUInt32LE(((e.mode & 0xffff) << 16 | (e.isDir ? 0x10 : 0)) >>> 0, 38); // unix mode in the high half, DOS dir bit
      h.writeUInt32LE(e.offset, 42);
      e.nameBuf.copy(h, 46);
      await this._write(h);
    }
    const cdSize = this.offset - cdStart;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(SIG_END, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(cdSize, 12);
    end.writeUInt32LE(cdStart, 16);
    end.writeUInt16LE(0, 20);
    await this._write(end);
    await new Promise((resolve, reject) => this.out.end((err) => (err ? reject(err) : resolve())));
    return { size: this.offset, entries: this.entries.length };
  }
}

/**
 * Plan what goes into the archive: a sorted walk of `rootAbs` with the skip
 * rules applied, stopping at the caps. `exclude` are '/'-separated paths
 * relative to the folder (the web's paid-locked children); anything at or
 * under one is left out and counted in `skipped`.
 */
export async function planFolder(rootAbs, { exclude = [], maxFiles = ZIP_LIMITS.maxFiles, maxBytes = ZIP_LIMITS.maxBytes, deadline = Infinity } = {}) {
  const excluded = new Set(exclude.map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean));
  const files = [], dirs = [];
  let bytes = 0, skipped = 0;
  const isExcluded = (rel) => {
    for (const x of excluded) if (rel === x || rel.startsWith(x + "/")) return true;
    return false;
  };
  const walk = async (dirAbs, rel) => {
    if (Date.now() > deadline) throw new ZipLimitError("timed out");
    const ents = await fsp.readdir(dirAbs, { withFileTypes: true });
    ents.sort((a, b) => a.name.localeCompare(b.name));
    let kept = 0;
    for (const e of ents) {
      if (ZIP_SKIP_NAMES.has(e.name)) continue;
      if (e.isDirectory() && isBareName(e.name)) continue;
      if (e.isSymbolicLink()) continue; // never follow out of the drive
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (isExcluded(childRel)) { skipped++; continue; }
      const childAbs = path.join(dirAbs, e.name);
      if (e.isDirectory()) {
        kept++;
        await walk(childAbs, childRel);
      } else if (e.isFile()) {
        kept++;
        const st = await fsp.stat(childAbs);
        files.push({ rel: childRel, abs: childAbs, size: st.size, mtimeMs: st.mtimeMs, mode: st.mode });
        bytes += st.size;
        if (files.length > maxFiles) throw new ZipLimitError(`more than ${maxFiles} files`);
        if (bytes > maxBytes) throw new ZipLimitError(`more than ${maxBytes} bytes`);
      }
    }
    if (kept === 0 && rel) {
      const st = await fsp.stat(dirAbs);
      dirs.push({ rel, mtimeMs: st.mtimeMs }); // keep empty folders
    }
  };
  await walk(rootAbs, "");
  return { files, dirs, bytes, skipped };
}

/**
 * Zip the folder at `rootAbs` to `outAbs`. Returns { size, files, bytes, skipped }.
 * The output is removed if anything fails, so a caller never finds a half zip.
 */
export async function zipFolder(rootAbs, outAbs, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? ZIP_LIMITS.timeoutMs;
  const deadline = Date.now() + timeoutMs;
  const plan = await planFolder(rootAbs, { ...opts, deadline });
  await fsp.mkdir(path.dirname(outAbs), { recursive: true });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new ZipLimitError("timed out")), Math.max(0, deadline - Date.now()));
  const out = createWriteStream(outAbs);
  const zw = new ZipWriter(out);
  try {
    for (const d of plan.dirs) await zw.addDirectory(d.rel, d.mtimeMs);
    for (const f of plan.files) {
      if (ac.signal.aborted) throw ac.signal.reason;
      await zw.addFile(f.rel, f.abs, { mtimeMs: f.mtimeMs, mode: f.mode, signal: ac.signal });
    }
    const { size } = await zw.finalize();
    return { size, files: plan.files.length, bytes: plan.bytes, skipped: plan.skipped };
  } catch (e) {
    out.destroy();
    await fsp.rm(outAbs, { force: true }).catch(() => {});
    throw ac.signal.aborted ? ac.signal.reason : e;
  } finally {
    clearTimeout(timer);
  }
}

/** Drop finished zips nobody fetched (the web deletes each one after streaming; this is the safety net). */
export async function pruneStaleZips(dirAbs, maxAgeMs = 60 * 60 * 1000) {
  let names;
  try { names = await fsp.readdir(dirAbs); } catch { return; }
  const cutoff = Date.now() - maxAgeMs;
  for (const n of names) {
    const p = path.join(dirAbs, n);
    try {
      const st = await fsp.stat(p);
      if (st.isFile() && st.mtimeMs < cutoff) await fsp.rm(p, { force: true });
    } catch {}
  }
}
