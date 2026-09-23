// Server-side preview conversion (fs/preview): legacy Office / iWork /
// PostScript / XPS → PDF and non-browser video → H.264 MP4, done by the
// isolated converter sidecar (web/converter/) and cached on disk.
//
// Jobs are asynchronous: the route kicks one off and answers 202 while it
// runs, so a 20-minute transcode never sits behind a proxy timeout. One job
// per cache path (concurrent viewers join it); a failure is remembered for a
// while so polling clients get a definitive 422 instead of a retry storm.
// Design: docs/superpowers/specs/2026-09-23-file-preview-coverage-design.md §3.
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat as fsStat } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { agentByteStream } from "@/lib/agent-stream";
import { extOf, previewKindFor } from "@/lib/preview-kind";

export type PreviewTarget = "pdf" | "mp4";

export const MAX_SOURCE_BYTES = envInt("AINDRIVE_PREVIEW_MAX_SOURCE_BYTES", 512 * 1024 * 1024);
export const MAX_JOBS = envInt("AINDRIVE_PREVIEW_MAX_JOBS", 4);
// Per drive, so one viewer (or one drive's public link) can't take every slot.
export const MAX_JOBS_PER_DRIVE = envInt("AINDRIVE_PREVIEW_MAX_JOBS_PER_DRIVE", 2);
// Total size of $AINDRIVE_DATA_DIR/previews. It shares a volume with the
// SQLite DB, so it must never be allowed to fill the disk.
export const CACHE_MAX_BYTES = envInt("AINDRIVE_PREVIEW_CACHE_MAX_BYTES", 5 * 1024 * 1024 * 1024);
// Remembered failures are keyed per file version; a hostile agent can mint
// versions freely, so the map is swept + hard-capped.
const MAX_FAILURES = 1000;
/** How long a failed conversion answers 422 before the next request retries. */
export const FAILURE_TTL_MS = 10 * 60_000;
// Upper bound for one job end-to-end (agent pull + convert + write). The
// sidecar enforces its own per-engine timeouts; this only stops a wedged
// socket from pinning a job slot forever.
const JOB_TIMEOUT_MS = 45 * 60_000;

function envInt(name: string, dflt: number): number {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

/**
 * The only allowed (file, target) pairs: PDF for the "converted" kind, MP4 for
 * video and audio (audio only reaches here when the browser can't decode it). Anything else is a 400 — the converter is never asked to parse a
 * type the Viewer would not have sent to it.
 */
export function previewTargetFor(path: string, to: string | null): PreviewTarget | null {
  const kind = previewKindFor(path);
  if (to === "pdf" && kind === "converted") return "pdf";
  if (to === "mp4" && (kind === "video" || kind === "audio")) return "mp4";
  return null;
}

export const PREVIEW_MIME: Record<PreviewTarget, string> = {
  pdf: "application/pdf",
  mp4: "video/mp4",
};

/**
 * The agent's stat reply, validated. The agent is user-controlled (anyone can
 * run a modified CLI for their own drive), and mtime/size end up in a cache
 * file name — a string mtime like "/../../<otherDrive>/…" would otherwise
 * walk out of this drive's cache dir. null → reject the reply.
 */
export function validAgentStat(entry: { mtimeMs?: unknown; size?: unknown }): { mtimeMs: number; size: number } | null {
  const { mtimeMs, size } = entry;
  if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs)) return null;
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return null;
  return { mtimeMs: Math.trunc(mtimeMs), size: Math.trunc(size) };
}

// Mirrors lib/db.js dataDir (not exported there) — same root as fs/thumbnail.
export function previewDataDir(): string {
  return process.env.AINDRIVE_DATA_DIR || join(homedir(), ".aindrive");
}

/** Throws unless `file` resolves strictly inside `dir` (defense in depth). */
export function assertInside(dir: string, file: string): string {
  const root = resolve(dir) + sep;
  const out = resolve(file);
  if (!out.startsWith(root)) throw new Error("cache path escapes its directory");
  return out;
}

export function previewCachePath(
  driveId: string,
  path: string,
  mtimeMs: number,
  size: number,
  target: PreviewTarget,
  dataDir = previewDataDir(),
): string {
  // Keyed by path + mtime + size: editing the file changes the key, so a stale
  // conversion is never served. Old keys are evicted by size (evictPreviewCache).
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(size)) throw new Error("invalid stat");
  const key = `${createHash("sha1").update(path).digest("hex")}-${Math.trunc(mtimeMs)}-${Math.trunc(size)}.${target}`;
  const previews = join(dataDir, "previews");
  const driveDir = assertInside(previews, join(previews, driveId));
  return assertInside(driveDir, join(driveDir, key));
}

// ── magic bytes ─────────────────────────────────────────────────────────────
// Every converter engine sniffs content, not the extension: a "server.key"
// that is really a PEM key, or a Graphviz ".dot", would otherwise be shipped
// to the sidecar and a PDF copy of it cached. Checked on the first 8 bytes
// before any job starts. Mirrored by hand in web/converter/server.mjs.
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const RTF = [0x7b, 0x5c, 0x72, 0x74, 0x66]; // {\rtf
const PS = [0x25, 0x21]; // %! (PostScript files start "%!PS-Adobe" or bare "%!")
const DOS_EPS = [0xc5, 0xd0, 0xd3, 0xc6];
const WPD = [0xff, 0x57, 0x50, 0x43];
export const CONVERT_MAGIC: Record<string, number[][]> = {
  doc: [OLE2], dot: [OLE2], ppt: [OLE2], pps: [OLE2], pot: [OLE2],
  key: [ZIP], numbers: [ZIP], pages: [ZIP], odt: [ZIP], ott: [ZIP], odp: [ZIP], xps: [ZIP], oxps: [ZIP],
  rtf: [RTF],
  eps: [PS, DOS_EPS], ps: [PS, DOS_EPS],
  wpd: [WPD],
};
/** Magic sniffed from the first bytes of a file (≥ 8). */
export const MAGIC_BYTES = 8;

/** True when `head` starts with a signature for `ext`; exts with no entry (video/audio) pass. */
export function magicMatches(ext: string, head: Uint8Array): boolean {
  const sigs = CONVERT_MAGIC[ext];
  if (!sigs) return true;
  return sigs.some((sig) => sig.length <= head.length && sig.every((b, i) => head[i] === b));
}

// ── cache eviction ──────────────────────────────────────────────────────────
let evicting = false;

/**
 * Delete the least-recently-used files under `root` (previews/<drive>/<key>)
 * until the total is ≤ maxBytes. "Used" = the later of atime/mtime; cache
 * hits bump the time (fs/preview touches the file) since relatime/noatime
 * mounts don't. A plain directory scan: runs after each successful write,
 * not per request. In-flight `.tmp` files are counted but never deleted.
 */
export async function evictPreviewCache(root: string, maxBytes: number): Promise<number> {
  if (evicting) return 0;
  evicting = true;
  try {
    const files: Array<{ path: string; size: number; used: number; tmp: boolean }> = [];
    for (const d of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!d.isDirectory()) continue;
      const dir = join(root, d.name);
      for (const f of await readdir(dir).catch(() => [] as string[])) {
        const st = await fsStat(join(dir, f)).catch(() => null);
        if (!st?.isFile()) continue;
        files.push({ path: join(dir, f), size: st.size, used: Math.max(st.atimeMs, st.mtimeMs), tmp: f.endsWith(".tmp") });
      }
    }
    let total = files.reduce((n, f) => n + f.size, 0);
    let removed = 0;
    files.sort((a, b) => a.used - b.used);
    for (const f of files) {
      if (total <= maxBytes) break;
      if (f.tmp) continue;
      await rm(f.path, { force: true }).catch(() => {});
      total -= f.size;
      removed++;
    }
    return removed;
  } finally {
    evicting = false;
  }
}

// ── job registry ────────────────────────────────────────────────────────────
// Pinned on globalThis (like the agent map) so HMR / bundle duplication share
// one registry instead of starting duplicate jobs.
type Registry = {
  jobs: Map<string, { driveId: string; done: Promise<void> }>;
  failures: Map<string, { error: string; status: number; at: number }>;
};
const g = globalThis as typeof globalThis & { __aindrivePreviewJobsV2?: Registry };
const reg: Registry = (g.__aindrivePreviewJobsV2 ??= { jobs: new Map(), failures: new Map() });

export type JobState =
  | { state: "pending" }
  | { state: "failed"; error: string; status: number }
  | { state: "busy" };

export type JobSpec = {
  cachePath: string;
  driveId: string;
  driveSecret: string;
  path: string;
  size: number;
  target: PreviewTarget;
  converterUrl: string;
  /** previews/ root for eviction; defaults to the data dir's. */
  cacheRoot?: string;
};

/** A job for this cache path is running (the route skips re-sniffing then). */
export function jobRunning(cachePath: string): boolean {
  return reg.jobs.has(cachePath);
}

function sweepFailures(now: number): void {
  for (const [k, f] of reg.failures) if (now - f.at >= FAILURE_TTL_MS) reg.failures.delete(k);
  // Map iterates in insertion order → drop the oldest past the cap.
  for (const k of reg.failures.keys()) {
    if (reg.failures.size <= MAX_FAILURES) break;
    reg.failures.delete(k);
  }
}

/** Start (or join) the conversion for `spec.cachePath`. Never throws. */
export function ensureJob(spec: JobSpec, now = Date.now()): JobState {
  sweepFailures(now);
  const failed = reg.failures.get(spec.cachePath);
  if (failed) return { state: "failed", error: failed.error, status: failed.status };
  if (reg.jobs.has(spec.cachePath)) return { state: "pending" };
  if (reg.jobs.size >= MAX_JOBS) return { state: "busy" };
  let driveJobs = 0;
  for (const j of reg.jobs.values()) if (j.driveId === spec.driveId) driveJobs++;
  if (driveJobs >= MAX_JOBS_PER_DRIVE) return { state: "busy" };
  const done = runJob(spec)
    .catch((e: unknown) => {
      const error = e instanceof Error ? e.message : "conversion failed";
      console.warn(`[preview] ${spec.target} ${spec.path}: ${error}`);
      // A busy sidecar is not a verdict on the file — let the next poll retry.
      // 415 = the sidecar's content check (e.g. a playlist renamed .avi) — kept
      // distinct so the client can say "not really a <type>".
      const status = e instanceof ConvertFailed && e.status === 415 ? 415 : 422;
      if (!(e instanceof ConverterBusy)) reg.failures.set(spec.cachePath, { error, status, at: Date.now() });
    })
    .finally(() => { reg.jobs.delete(spec.cachePath); });
  reg.jobs.set(spec.cachePath, { driveId: spec.driveId, done });
  return { state: "pending" };
}

class ConverterBusy extends Error {}
class ConvertFailed extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function runJob(spec: JobSpec): Promise<void> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("conversion timed out")), JOB_TIMEOUT_MS);
  const tmp = `${spec.cachePath}.${process.pid}.${Date.now()}.tmp`;
  let body: Readable | undefined;
  try {
    await mkdir(dirname(spec.cachePath), { recursive: true });
    const url = new URL(`/convert?to=${spec.target}&ext=${encodeURIComponent(extOf(spec.path))}`, spec.converterUrl);
    body = Readable.fromWeb(
      agentByteStream(spec.driveId, spec.driveSecret, spec.path, 0, spec.size) as import("node:stream/web").ReadableStream<Uint8Array>,
    );
    const res = await postStream(url, body, ac.signal);
    if (res.statusCode === 503) { res.destroy(); throw new ConverterBusy("converter busy"); }
    if (res.statusCode !== 200) {
      const text = await readSmall(res);
      let msg = `converter returned ${res.statusCode}`;
      try { msg = (JSON.parse(text) as { error?: string }).error || msg; } catch { /* not JSON */ }
      throw new ConvertFailed(msg, res.statusCode ?? 500);
    }
    // tmp + rename: a reader never sees a half-written file under the final key.
    await pipeline(res, createWriteStream(tmp), { signal: ac.signal });
    await rename(tmp, spec.cachePath);
    // Off the job's critical path; a failed sweep must not fail the preview.
    void evictPreviewCache(spec.cacheRoot ?? join(previewDataDir(), "previews"), CACHE_MAX_BYTES).catch(() => {});
  } finally {
    clearTimeout(timer);
    // Early converter error (415/413/…) → stop pulling bytes from the agent.
    body?.destroy();
    await rm(tmp, { force: true }).catch(() => {});
  }
}

// node:http rather than fetch: undici's fetch aborts when response headers
// take > 300s, and the sidecar only sends headers once a (possibly 20-minute)
// transcode is done.
function postStream(url: URL, body: Readable, signal: AbortSignal): Promise<IncomingMessage> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      signal,
    }, resolve);
    req.on("error", reject);
    body.on("error", (e) => req.destroy(e));
    body.pipe(req);
  });
}

async function readSmall(res: IncomingMessage): Promise<string> {
  let s = "";
  for await (const chunk of res) { s += chunk; if (s.length > 4096) break; }
  res.destroy();
  return s.slice(0, 4096);
}

/** Test hook: number of remembered failures. */
export function _failureCount(): number {
  return reg.failures.size;
}

/** Test hook: forget all jobs + remembered failures. */
export function _resetPreviewJobs(): void {
  reg.jobs.clear();
  reg.failures.clear();
}
