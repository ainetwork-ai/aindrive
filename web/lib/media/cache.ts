// The server as a verifying cache peer for large files (P2P media spec M3/M4):
// a device's uplink carries each 1 MiB chunk once; replays, seeks and other viewers
// are served from <dataDir>/media-cache/<drive>/<root>/<index>. Every chunk fetched
// from the device is checked against the file's chunk hash list (media-index), so a
// corrupt or substituted chunk is never kept or served. Access is not decided here:
// callers (fs/stream, fs/download) keep their own gates.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { callAgent } from "@/lib/rpc";
import { agentByteStream } from "@/lib/agent-stream";
import { dataDir } from "@/lib/env";
import { CHUNK_BYTES } from "@/shared/media/chunks";
import { fromHex, toHex } from "@/shared/willow/bytes";

export type Manifest = { size: number; mtimeMs: number; outboard: Uint8Array; root: Uint8Array; rootHex: string };

const PREFETCH = 2;
const CHUNK_TIMEOUT_MS = 120_000;
const INDEX_TIMEOUT_MS = 10 * 60_000; // hashing a long video on a phone takes a while, once
const HEX64 = /^[0-9a-f]{64}$/;

const manifests = new Map<string, { m: Manifest | null; until: number }>();
const indexing = new Map<string, Promise<Manifest | null>>();
const NO_INDEX_MS = 10 * 60_000;
// the last manifest seen per file: serves cached ranges while the device is offline
const lastByPath = new Map<string, Manifest>();
const inflight = new Map<string, Promise<Uint8Array>>();

const mb = (v: string | undefined, dflt: number) => { const n = Number(v); return (Number.isFinite(n) && n > 0 ? n : dflt) * 1024 * 1024; };
const budgetBytes = () => mb(process.env.AINDRIVE_MEDIA_CACHE_MB, 2048);
const totalBudgetBytes = () => mb(process.env.AINDRIVE_MEDIA_CACHE_TOTAL_MB, 8192);
const driveDir = (driveId: string) => join(dataDir(), "media-cache", driveId.replace(/[^A-Za-z0-9_-]/g, "_"));

/**
 * The file's manifest: its chunk hash list from the agent (`media-index`), checked
 * for shape, keyed by size + mtime so a changed file is indexed again. Null when the
 * agent cannot index (an old agent): the caller streams the old way.
 */
export async function mediaManifest(driveId: string, secret: string, path: string, stat: { size: number; mtimeMs: number }): Promise<Manifest | null> {
  const key = `${driveId}\0${path}\0${stat.size}\0${stat.mtimeMs}`;
  const hit = manifests.get(key);
  if (hit && (hit.m || hit.until > Date.now())) return hit.m;
  const running = indexing.get(key);
  if (running) return running; // review I1: one media-index per file at a time
  const p = (async (): Promise<Manifest | null> => {
    let r: { size: number; mtimeMs: number; chunk: number; leaves: string[]; pending?: boolean };
    try {
      r = (await callAgent(driveId, secret, { method: "media-index", path } as never, { timeoutMs: INDEX_TIMEOUT_MS })) as never;
    } catch (e) {
      // an old agent: remember "no index" for a while; anything else: ask again next time
      if (/unknown method|not supported|unsupported/i.test(String((e as Error)?.message))) remember(key, null, NO_INDEX_MS);
      return null;
    }
    if (r.pending) return null; // the device is hashing in the background (review I2/I3): stream directly meanwhile
    const count = Math.ceil(r.size / CHUNK_BYTES);
    if (!(r.chunk === CHUNK_BYTES && r.size === stat.size && Array.isArray(r.leaves) && r.leaves.length === count && r.leaves.every((h) => HEX64.test(h)))) return null;
    const outboard = new Uint8Array(count * 32);
    r.leaves.forEach((h, i) => outboard.set(fromHex(h), i * 32));
    const root = sha256(outboard);
    const m: Manifest = { size: r.size, mtimeMs: r.mtimeMs, outboard, root, rootHex: toHex(root) };
    remember(key, m, 0);
    if (lastByPath.size > 5000) lastByPath.clear();
    lastByPath.set(`${driveId}\0${path}`, m);
    return m;
  })().finally(() => indexing.delete(key));
  indexing.set(key, p);
  return p;
}

function remember(key: string, m: Manifest | null, forMs: number) {
  if (manifests.size > 1000) manifests.clear();
  manifests.set(key, { m, until: Date.now() + forMs });
}

/** What the routes learned from the device about the file now (null: gone). A
 *  different size or mtime, or a deleted file, forgets the manifest that would
 *  otherwise keep serving the old version while the device is offline (review I4). */
export function noteStat(driveId: string, path: string, stat: { size: number; mtimeMs: number } | null) {
  const k = `${driveId}\0${path}`;
  const m = lastByPath.get(k);
  if (m && (!stat || stat.size !== m.size || stat.mtimeMs !== m.mtimeMs)) lastByPath.delete(k);
}

// Native SHA-256 for chunks already on disk, and each verified once per process (review I5).
const verifiedOnDisk = new Set<string>();
function chunkOk(b: Uint8Array, i: number, m: Manifest): boolean {
  if (i < Math.ceil(m.size / CHUNK_BYTES) - 1 ? b.length !== CHUNK_BYTES : b.length === 0 || b.length > CHUNK_BYTES) return false;
  const h = createHash("sha256").update(b).digest();
  return Buffer.compare(h, Buffer.from(m.outboard.subarray(i * 32, i * 32 + 32))) === 0;
}

async function chunk(driveId: string, secret: string, path: string, m: Manifest, i: number): Promise<Uint8Array> {
  const file = join(driveDir(driveId), m.rootHex, String(i));
  if (existsSync(file)) {
    const b = new Uint8Array(readFileSync(file));
    if (verifiedOnDisk.has(file) || chunkOk(b, i, m)) {
      if (verifiedOnDisk.size > 50_000) verifiedOnDisk.clear();
      verifiedOnDisk.add(file);
      const now = new Date();
      try { utimesSync(file, now, now); } catch {} // recency for LRU
      return b;
    }
    rmSync(file, { force: true }); // a damaged cache file is dropped, then fetched again
  }
  const shared = inflight.get(file);
  if (shared) return shared;
  const p = (async () => {
    const length = Math.min(CHUNK_BYTES, m.size - i * CHUNK_BYTES);
    const r = await callAgent(driveId, secret, { method: "download-chunk", path, offset: i * CHUNK_BYTES, length }, { timeoutMs: CHUNK_TIMEOUT_MS }) as { data: string };
    const b = new Uint8Array(Buffer.from(r.data, "base64"));
    if (!chunkOk(b, i, m)) throw new Error(`chunk ${i} of ${path} failed verification`);
    mkdirSync(join(driveDir(driveId), m.rootHex), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, b);
    renameSync(tmp, file);
    verifiedOnDisk.add(file);
    maybeEvict(driveId, b.length);
    return b;
  })().finally(() => inflight.delete(file));
  inflight.set(file, p);
  return p;
}

/** Bytes [start, endExclusive) of the file, chunk by chunk from the cache or the device, verified. */
export function cachedByteStream(driveId: string, secret: string, path: string, m: Manifest, start: number, endExclusive: number): ReadableStream<Uint8Array> {
  let i = Math.floor(start / CHUNK_BYTES);
  const last = Math.floor((endExclusive - 1) / CHUNK_BYTES);
  const count = Math.ceil(m.size / CHUNK_BYTES);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i > last || endExclusive <= start) { controller.close(); return; }
      try {
        const b = await chunk(driveId, secret, path, m, i);
        for (let k = 1; k <= PREFETCH && i + k < count; k++) void chunk(driveId, secret, path, m, i + k).catch(() => {});
        const from = Math.max(start - i * CHUNK_BYTES, 0);
        const to = Math.min(endExclusive - i * CHUNK_BYTES, b.length);
        controller.enqueue(b.subarray(from, to));
        i++;
      } catch (e) {
        controller.error(e);
      }
    },
  });
}

type CachedFile = { path: string; size: number; t: number };
function filesUnder(dir: string): CachedFile[] {
  const out: CachedFile[] = [];
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n.includes(".tmp-")) continue;
      const p = join(d, n);
      try { const st = statSync(p); if (st.isDirectory()) walk(p); else out.push({ path: p, size: st.size, t: st.mtimeMs }); } catch {}
    }
  };
  walk(dir);
  return out;
}
function trim(files: CachedFile[], budget: number) {
  let total = files.reduce((n, f) => n + f.size, 0);
  if (total <= budget) return;
  files.sort((a, b) => a.t - b.t);
  for (const f of files) {
    if (total <= budget) break;
    rmSync(f.path, { force: true });
    verifiedOnDisk.delete(f.path);
    total -= f.size;
  }
}

/** Keeps a drive's cache under its budget, least recently used chunks first. */
export function evict(driveId: string) {
  trim(filesUnder(driveDir(driveId)), budgetBytes());
}

/** Keeps the whole cache (every drive) under the total budget (review I6). */
export function evictAll() {
  trim(filesUnder(join(dataDir(), "media-cache")), totalBudgetBytes());
}

// Eviction scans directories, so it runs every 64 MiB written or every 30 s, not per chunk.
let writtenSinceEvict = 0, lastEvict = 0;
function maybeEvict(driveId: string, bytes: number) {
  writtenSinceEvict += bytes;
  if (writtenSinceEvict < 64 * 1048576 && Date.now() - lastEvict < 30_000) return;
  writtenSinceEvict = 0; lastEvict = Date.now();
  evict(driveId);
  evictAll();
}

/**
 * The bytes the fs/stream and fs/download routes serve: through the verifying cache
 * when the file is at least one chunk and the agent can index it, else streamed from
 * the agent as before (an old agent, or a small file).
 */
export async function bytesFor(driveId: string, secret: string, path: string, stat: { size: number; mtimeMs: number }, start: number, endExclusive: number): Promise<ReadableStream<Uint8Array>> {
  const m = stat.size >= CHUNK_BYTES ? await mediaManifest(driveId, secret, path, stat) : null;
  return m ? cachedByteStream(driveId, secret, path, m, start, endExclusive) : agentByteStream(driveId, secret, path, start, endExclusive);
}

/**
 * The device is unreachable (asleep, offline): serve [start, endExclusive) from the
 * cache alone when every chunk it needs is cached and still verifies, with the size
 * from the last manifest. Null when anything is missing (P2P media spec, goal 3).
 */
export function cachedOnly(driveId: string, path: string, start: number, endExclusive: number): { size: number; stream: ReadableStream<Uint8Array> } | null {
  const m = lastByPath.get(`${driveId}\0${path}`);
  if (!m) return null;
  const end = Math.min(endExclusive, m.size);
  if (start >= end) return null;
  for (let i = Math.floor(start / CHUNK_BYTES); i <= Math.floor((end - 1) / CHUNK_BYTES); i++) {
    if (!existsSync(join(driveDir(driveId), m.rootHex, String(i)))) return null;
  }
  // every chunk is on disk: chunk() reads (and re-verifies) them without calling the agent
  return { size: m.size, stream: cachedByteStream(driveId, "", path, m, start, end) };
}

/** The size of the file as last indexed, for serving it while the device is offline; null if never indexed. */
export function cachedSize(driveId: string, path: string): number | null {
  return lastByPath.get(`${driveId}\0${path}`)?.size ?? null;
}
