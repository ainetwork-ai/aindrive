import { promises as fsp } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import * as Y from "yjs";
import { appendUpdate, listEntries, statsForDoc, maybeCompact } from "./willow-store.js";

// Standard observability — stdout structured logs + optional POST to server's
// /api/dev/trace ring buffer. NO file writes.
let _serverUrl = null;
const _pending = [];
let _flushTimer = null;
export function setTraceServer(url) { _serverUrl = url; }

function flushSoon() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(async () => {
    _flushTimer = null;
    if (!_serverUrl || _pending.length === 0) { _pending.length = 0; return; }
    const batch = _pending.splice(0);
    try {
      const { request } = await import("undici");
      await request(new URL("/api/dev/trace", _serverUrl).toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batch),
      });
    } catch {}
  }, 250);
}

function cliTrace(_root, docId, event, extra = {}) {
  if (process.env.AINDRIVE_TRACE === "off") return;
  if (!docId) return;
  const evt = { t: Date.now(), src: "cli", docId, event, ...extra };
  try { console.log(JSON.stringify({ level: "info", ns: "aindrive.trace", ...evt })); } catch {}
  _pending.push(evt);
  flushSoon();
}

function docIdFor(_root, relPath) {
  return createHash("sha1").update(relPath || "").digest("base64url").slice(0, 22);
}

export { cliTrace, docIdFor };

// Self-write suppression for fs.watch: agent.js consults this set to ignore
// changes that came from our own write RPC.
const _suppressedPaths = new Map(); // path → expireMs
function _suppressFsChange(path, ttlMs = 2000) {
  _suppressedPaths.set(path, Date.now() + ttlMs);
}
export function isSelfWrite(path) {
  const exp = _suppressedPaths.get(path);
  if (!exp) return false;
  if (Date.now() > exp) { _suppressedPaths.delete(path); return false; }
  return true;
}

const RPC_METHODS = new Set([
  "list", "stat", "read", "write", "mkdir", "rename", "delete",
  "upload-chunk", "download-chunk", "yjs-write", "yjs-read", "yjs-stats",
]);

const HIDDEN = new Set([".aindrive", ".DS_Store", ".git"]);
const LIMITS = {
  maxPathBytes: 4096,
  maxReadBytes: 8 * 1024 * 1024,
  maxUploadChunkBytes: 4 * 1024 * 1024,
};

export function safeResolve(root, rel) {
  if (typeof rel !== "string") throw new Error("invalid path");
  if (Buffer.byteLength(rel, "utf8") > LIMITS.maxPathBytes) throw new Error("path too long");
  const joined = path.resolve(root, "." + path.sep + rel);
  if (joined !== root && !joined.startsWith(root + path.sep)) {
    throw new Error("path escapes drive root");
  }
  return joined;
}

export function toRel(root, abs) {
  return path.relative(root, abs).split(path.sep).join("/");
}

function guessMime(name) {
  const ext = path.extname(name).toLowerCase();
  const map = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
    ".js": "text/javascript", ".mjs": "text/javascript", ".ts": "text/typescript",
    ".tsx": "text/typescript", ".jsx": "text/javascript",
    ".html": "text/html", ".css": "text/css",
    ".py": "text/x-python", ".rs": "text/x-rust", ".go": "text/x-go",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  };
  return map[ext] || "application/octet-stream";
}

async function toEntry(root, abs) {
  const stat = await fsp.stat(abs);
  const name = path.basename(abs);
  return {
    name,
    path: toRel(root, abs),
    isDir: stat.isDirectory(),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ext: path.extname(name).slice(1).toLowerCase(),
    mime: stat.isDirectory() ? "folder" : guessMime(name),
  };
}

export async function handleRpc(params, root) {
  if (!params || !RPC_METHODS.has(params.method)) throw new Error("unknown method");

  switch (params.method) {
    case "list": {
      const abs = safeResolve(root, params.path || "");
      const entries = await fsp.readdir(abs, { withFileTypes: true });
      const out = [];
      for (const e of entries) {
        if (HIDDEN.has(e.name)) continue;
        const full = path.join(abs, e.name);
        try { out.push(await toEntry(root, full)); } catch {}
      }
      out.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
      return { method: "list", entries: out };
    }
    case "stat": {
      const abs = safeResolve(root, params.path);
      try { return { method: "stat", entry: await toEntry(root, abs) }; }
      catch { return { method: "stat", entry: null }; }
    }
    case "read": {
      const abs = safeResolve(root, params.path);
      const st = await fsp.stat(abs);
      if (st.isDirectory()) throw new Error("is a directory");
      const maxBytes = Math.min(params.maxBytes ?? LIMITS.maxReadBytes, LIMITS.maxReadBytes);
      const fh = await fsp.open(abs, "r");
      try {
        const buf = Buffer.alloc(Math.min(st.size, maxBytes));
        await fh.read(buf, 0, buf.length, 0);
        const encoding = params.encoding === "base64" ? "base64" : "utf8";
        return { method: "read", content: buf.toString(encoding), encoding, truncated: st.size > buf.length };
      } finally { await fh.close(); }
    }
    case "write": {
      const abs = safeResolve(root, params.path);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      const encoding = params.encoding === "base64" ? "base64" : "utf8";
      const data = Buffer.from(params.content, encoding);
      // Suppress fs-changed for 2s after our own write so reload loop doesn't fire
      try { _suppressFsChange(params.path); } catch {}
      await fsp.writeFile(abs, data);
      try { cliTrace(root, docIdFor(root, params.path), "disk-write", { extra: { path: params.path, byteLen: data.length } }); } catch {}
      return { method: "write", ok: true, bytes: data.length };
    }
    case "mkdir": {
      const abs = safeResolve(root, params.path);
      await fsp.mkdir(abs, { recursive: true });
      return { method: "mkdir", ok: true };
    }
    case "rename": {
      const from = safeResolve(root, params.from);
      const to = safeResolve(root, params.to);
      if (from === root) throw new Error("cannot rename root");
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.rename(from, to);
      return { method: "rename", ok: true };
    }
    case "delete": {
      const abs = safeResolve(root, params.path);
      if (abs === root) throw new Error("cannot delete root");
      await fsp.rm(abs, { recursive: true, force: true });
      return { method: "delete", ok: true };
    }
    case "upload-chunk": {
      const abs = safeResolve(root, params.path);
      const buf = Buffer.from(params.data, "base64");
      if (buf.length > LIMITS.maxUploadChunkBytes) throw new Error("chunk too large");
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      const fh = await fsp.open(abs, params.chunkId === 0 ? "w" : "a");
      try { await fh.write(buf); }
      finally { await fh.close(); }
      return { method: "upload-chunk", ok: true, receivedBytes: buf.length };
    }
    case "download-chunk": {
      const abs = safeResolve(root, params.path);
      const fh = await fsp.open(abs, "r");
      try {
        const st = await fh.stat();
        const length = Math.min(params.length ?? LIMITS.maxUploadChunkBytes, LIMITS.maxUploadChunkBytes);
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, params.offset);
        const eof = params.offset + bytesRead >= st.size;
        return { method: "download-chunk", data: buf.subarray(0, bytesRead).toString("base64"), eof };
      } finally { await fh.close(); }
    }
    case "yjs-write": {
      const docId = String(params.docId || "");
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(docId)) throw new Error("invalid docId");
      const data = Buffer.from(params.data, "base64");
      if (data.length > 4 * LIMITS.maxUploadChunkBytes) throw new Error("yjs blob too large");
      // Append to Willow Store (each save = new entry, history preserved)
      const { seq, digest } = appendUpdate(root, docId, data);
      try { cliTrace(root, params.docId, "willow-append", { extra: { docId: params.docId, seq, digest, byteLen: data.length } }); } catch {}
      // Fire-and-forget compaction check — does not block the RPC response
      maybeCompact(root, docId).catch((e) => console.warn("[yjs-write] maybeCompact error:", e.message));
      // Also write the latest snapshot as a single .bin for fast cold-start reads
      const yjsDir = path.join(root, ".aindrive", "yjs");
      await fsp.mkdir(yjsDir, { recursive: true });
      await fsp.writeFile(path.join(yjsDir, `${docId}.bin`), data);
      return { method: "yjs-write", ok: true, bytes: data.length, seq, digest };
    }
    case "yjs-read": {
      const docId = String(params.docId || "");
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(docId)) throw new Error("invalid docId");
      // Prefer Willow Store entries (replay all updates → single state)
      try {
        const entries = listEntries(root, docId);
        if (entries.length > 0) {
          const doc = new Y.Doc();
          for (const e of entries) {
            try { Y.applyUpdate(doc, new Uint8Array(e.payload)); } catch {}
          }
          const merged = Y.encodeStateAsUpdate(doc);
          try { cliTrace(root, params.docId, "willow-replay", { extra: { docId: params.docId, entries: entries.length, finalByteLen: merged.length } }); } catch {}
          return { method: "yjs-read", data: Buffer.from(merged).toString("base64"), bytes: merged.length };
        }
      } catch (e) { console.warn("[yjs-read] willow replay failed:", e.message); }
      // Fallback: legacy .bin snapshot
      const target = path.join(root, ".aindrive", "yjs", `${docId}.bin`);
      try {
        const buf = await fsp.readFile(target);
        return { method: "yjs-read", data: buf.toString("base64"), bytes: buf.length };
      } catch (e) {
        if (e.code === "ENOENT") return { method: "yjs-read", data: "", bytes: 0 };
        throw e;
      }
    }
    case "yjs-stats": {
      const docId = String(params.docId || "");
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(docId)) throw new Error("invalid docId");
      return { method: "yjs-stats", ...statsForDoc(root, docId) };
    }
  }
}
