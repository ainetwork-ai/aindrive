// The server as a verifying cache peer for large files (P2P media spec M3/M4):
// a device's uplink carries each 1 MiB chunk once; replays, seeks and other viewers
// are served from <dataDir>/media-cache/<drive>/<root>/<index>. Every chunk fetched
// from the device is checked against the file's chunk hash list (media-index), so a
// corrupt or substituted chunk is never kept or served. Access is not decided here:
// callers (fs/stream, fs/download) keep their own gates.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { callAgent } from "@/lib/rpc";
import { agentByteStream } from "@/lib/agent-stream";
import { dataDir } from "@/lib/env";
import { CHUNK_BYTES, verifyChunk } from "@/shared/media/chunks";
import { fromHex, toHex } from "@/shared/willow/bytes";

export type Manifest = { size: number; mtimeMs: number; outboard: Uint8Array; root: Uint8Array; rootHex: string };

const PREFETCH = 2;
const CHUNK_TIMEOUT_MS = 120_000;
const INDEX_TIMEOUT_MS = 10 * 60_000; // hashing a long video on a phone takes a while, once
const HEX64 = /^[0-9a-f]{64}$/;

const manifests = new Map<string, Manifest | null>();
// the last manifest seen per file: serves cached ranges while the device is offline
const lastByPath = new Map<string, Manifest>();
const inflight = new Map<string, Promise<Uint8Array>>();

const budgetBytes = () => Math.max(1, Number(process.env.AINDRIVE_MEDIA_CACHE_MB ?? 2048)) * 1024 * 1024;
const driveDir = (driveId: string) => join(dataDir(), "media-cache", driveId.replace(/[^A-Za-z0-9_-]/g, "_"));

/**
 * The file's manifest: its chunk hash list from the agent (`media-index`), checked
 * for shape, keyed by size + mtime so a changed file is indexed again. Null when the
 * agent cannot index (an old agent): the caller streams the old way.
 */
export async function mediaManifest(driveId: string, secret: string, path: string, stat: { size: number; mtimeMs: number }): Promise<Manifest | null> {
  const key = `${driveId}\0${path}\0${stat.size}\0${stat.mtimeMs}`;
  if (manifests.has(key)) return manifests.get(key)!;
  let m: Manifest | null = null;
  try {
    const r = (await callAgent(driveId, secret, { method: "media-index", path } as never, { timeoutMs: INDEX_TIMEOUT_MS })) as unknown as { size: number; mtimeMs: number; chunk: number; leaves: string[] };
    const count = Math.ceil(r.size / CHUNK_BYTES);
    if (r.chunk === CHUNK_BYTES && r.size === stat.size && Array.isArray(r.leaves) && r.leaves.length === count && r.leaves.every((h) => HEX64.test(h))) {
      const outboard = new Uint8Array(count * 32);
      r.leaves.forEach((h, i) => outboard.set(fromHex(h), i * 32));
      const root = sha256(outboard);
      m = { size: r.size, mtimeMs: r.mtimeMs, outboard, root, rootHex: toHex(root) };
    }
  } catch {
    m = null; // no media-index on this agent, or it failed: stream directly
  }
  if (manifests.size > 1000) manifests.clear();
  manifests.set(key, m);
  if (m) { if (lastByPath.size > 5000) lastByPath.clear(); lastByPath.set(`${driveId}\0${path}`, m); }
  return m;
}

async function chunk(driveId: string, secret: string, path: string, m: Manifest, i: number): Promise<Uint8Array> {
  const file = join(driveDir(driveId), m.rootHex, String(i));
  if (existsSync(file)) {
    const b = new Uint8Array(readFileSync(file));
    if (verifyChunk(b, i, m.outboard, m.root)) {
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
    if (!verifyChunk(b, i, m.outboard, m.root)) throw new Error(`chunk ${i} of ${path} failed verification`);
    mkdirSync(join(driveDir(driveId), m.rootHex), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, b);
    renameSync(tmp, file);
    evict(driveId);
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

/** Keeps a drive's cache under the budget, dropping the least recently used chunks first. */
export function evict(driveId: string) {
  const dir = driveDir(driveId);
  if (!existsSync(dir)) return;
  const files: { path: string; size: number; t: number }[] = [];
  for (const root of readdirSync(dir)) {
    const rd = join(dir, root);
    let names: string[];
    try { names = readdirSync(rd); } catch { continue; }
    for (const n of names) {
      if (n.includes(".tmp-")) continue;
      try { const s = statSync(join(rd, n)); files.push({ path: join(rd, n), size: s.size, t: s.mtimeMs }); } catch {}
    }
  }
  let total = files.reduce((n, f) => n + f.size, 0);
  const budget = budgetBytes();
  if (total <= budget) return;
  files.sort((a, b) => a.t - b.t);
  for (const f of files) {
    if (total <= budget) break;
    rmSync(f.path, { force: true });
    total -= f.size;
  }
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
