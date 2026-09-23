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
import { mkdir, rename, rm } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { agentByteStream } from "@/lib/agent-stream";
import { extOf, previewKindFor } from "@/lib/preview-kind";

export type PreviewTarget = "pdf" | "mp4";

export const MAX_SOURCE_BYTES = envInt("AINDRIVE_PREVIEW_MAX_SOURCE_BYTES", 512 * 1024 * 1024);
export const MAX_JOBS = envInt("AINDRIVE_PREVIEW_MAX_JOBS", 4);
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

// Mirrors lib/db.js dataDir (not exported there) — same root as fs/thumbnail.
export function previewCachePath(
  driveId: string,
  path: string,
  mtimeMs: number,
  target: PreviewTarget,
  dataDir = process.env.AINDRIVE_DATA_DIR || join(homedir(), ".aindrive"),
): string {
  // Keyed by path + mtime: editing the file changes the key, so a stale
  // conversion is never served. Old keys linger (GC is a follow-up).
  const key = `${createHash("sha1").update(path).digest("hex")}-${mtimeMs}.${target}`;
  return join(dataDir, "previews", driveId, key);
}

// ── job registry ────────────────────────────────────────────────────────────
// Pinned on globalThis (like the agent map) so HMR / bundle duplication share
// one registry instead of starting duplicate jobs.
type Registry = { jobs: Map<string, Promise<void>>; failures: Map<string, { error: string; at: number }> };
const g = globalThis as typeof globalThis & { __aindrivePreviewJobs?: Registry };
const reg: Registry = (g.__aindrivePreviewJobs ??= { jobs: new Map(), failures: new Map() });

export type JobState =
  | { state: "pending" }
  | { state: "failed"; error: string }
  | { state: "busy" };

export type JobSpec = {
  cachePath: string;
  driveId: string;
  driveSecret: string;
  path: string;
  size: number;
  target: PreviewTarget;
  converterUrl: string;
};

/** Start (or join) the conversion for `spec.cachePath`. Never throws. */
export function ensureJob(spec: JobSpec, now = Date.now()): JobState {
  const failed = reg.failures.get(spec.cachePath);
  if (failed) {
    if (now - failed.at < FAILURE_TTL_MS) return { state: "failed", error: failed.error };
    reg.failures.delete(spec.cachePath);
  }
  if (reg.jobs.has(spec.cachePath)) return { state: "pending" };
  if (reg.jobs.size >= MAX_JOBS) return { state: "busy" };
  const job = runJob(spec)
    .catch((e: unknown) => {
      const error = e instanceof Error ? e.message : "conversion failed";
      console.warn(`[preview] ${spec.target} ${spec.path}: ${error}`);
      // A busy sidecar is not a verdict on the file — let the next poll retry.
      if (!(e instanceof ConverterBusy)) reg.failures.set(spec.cachePath, { error, at: Date.now() });
    })
    .finally(() => { reg.jobs.delete(spec.cachePath); });
  reg.jobs.set(spec.cachePath, job);
  return { state: "pending" };
}

class ConverterBusy extends Error {}

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
      throw new Error(msg);
    }
    // tmp + rename: a reader never sees a half-written file under the final key.
    await pipeline(res, createWriteStream(tmp), { signal: ac.signal });
    await rename(tmp, spec.cachePath);
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

/** Test hook: forget all jobs + remembered failures. */
export function _resetPreviewJobs(): void {
  reg.jobs.clear();
  reg.failures.clear();
}
