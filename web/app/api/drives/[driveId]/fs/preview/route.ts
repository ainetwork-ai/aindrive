import { createReadStream } from "node:fs";
import { stat as fsStat, utimes } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { requireDriveRole } from "@/lib/require-access";
import { AgentError, callAgent } from "@/lib/rpc";
import { normalizePath } from "@/lib/path";
import { parseByteRange } from "@/lib/byte-range";
import { agentByteStream } from "@/lib/agent-stream";
import { extOf } from "@/lib/preview-kind";
import {
  MAGIC_BYTES, MAX_SOURCE_BYTES, PREVIEW_MIME, ensureJob, jobRunning, magicMatches,
  previewCachePath, previewTargetFor, validAgentStat,
} from "@/lib/preview-convert";

/**
 * GET /api/drives/:driveId/fs/preview?path=...&to=pdf|mp4&v=<mtimeMs>
 *
 * Server-converted preview for types the browser can't render: legacy
 * Office / iWork / PostScript / XPS → PDF, non-browser video → H.264 MP4.
 * The conversion runs in the isolated converter sidecar (web/converter/);
 * logic + job registry live in lib/preview-convert.ts.
 *
 *   202 {status:"pending"} — converting; poll again (clients send
 *                            `Range: bytes=0-0` so "ready" costs one byte)
 *   200 / 206              — converted bytes, Range-capable
 *   415 {error}            — content doesn't match the extension (magic bytes
 *                            here, or the sidecar's ffprobe format check)
 *   422 {error}            — conversion failed (remembered ~10 min, then retried)
 *   501                    — AINDRIVE_CONVERTER_URL unset
 *   502                    — the agent's stat reply was malformed
 *   503 + Retry-After      — too many conversions in flight (process or drive)
 *
 * Same viewer+ gate as fs/stream (requireDriveRole also applies the paid
 * carve-out), so a converted copy is exactly as reachable as the original.
 * Output is only ever PDF or MP4 (browser-passive types), never user bytes
 * verbatim. `v` is ignored: the cache key uses the agent's current mtime.
 */
export async function GET(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const url = new URL(req.url);
  const rawPath = url.searchParams.get("path");
  if (!rawPath) return NextResponse.json({ error: "path required" }, { status: 400 });
  let path: string;
  try { path = normalizePath(rawPath); }
  catch { return NextResponse.json({ error: "invalid path" }, { status: 400 }); }

  const target = previewTargetFor(path, url.searchParams.get("to"));
  if (!target) return NextResponse.json({ error: "unsupported preview target for this file" }, { status: 400 });

  const gate = await requireDriveRole(driveId, path, { min: "viewer" });
  if (gate instanceof NextResponse) return gate;
  const { drive } = gate;

  const converterUrl = process.env.AINDRIVE_CONVERTER_URL;
  if (!converterUrl) return NextResponse.json({ error: "preview converter not configured" }, { status: 501 });

  try {
    const stat = await callAgent(driveId, drive.drive_secret, { method: "stat", path }) as
      { entry: { mtimeMs: unknown; size: unknown; isDir: boolean } | null };
    if (!stat.entry || stat.entry.isDir) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    // mtime/size become part of a file name — never trust the agent's types.
    const entry = validAgentStat(stat.entry);
    if (!entry) return NextResponse.json({ error: "agent returned an invalid stat" }, { status: 502 });
    const cachePath = previewCachePath(driveId, path, entry.mtimeMs, entry.size, target);

    const cached = await fsStat(cachePath).catch(() => null);
    if (cached) {
      // Mark as recently used for eviction (relatime/noatime mounts won't).
      void utimes(cachePath, new Date(), cached.mtime).catch(() => {});
      const size = cached.size;
      const range = parseByteRange(req.headers.get("range"), size);
      if (!range.ok) {
        return NextResponse.json({ error: range.error }, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      }
      const { start, endExclusive } = range;
      const headers: Record<string, string> = {
        "Content-Type": PREVIEW_MIME[target],
        "Accept-Ranges": "bytes",
        "Content-Length": String(endExclusive - start),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      };
      if (range.partial) headers["Content-Range"] = `bytes ${start}-${endExclusive - 1}/${size}`;
      const body = Readable.toWeb(createReadStream(cachePath, { start, end: endExclusive - 1 })) as ReadableStream<Uint8Array>;
      return new Response(body, { status: range.partial ? 206 : 200, headers });
    }

    if (entry.size > MAX_SOURCE_BYTES) {
      return NextResponse.json({ error: "file too large to convert for preview", limit: MAX_SOURCE_BYTES }, { status: 413 });
    }
    if (entry.size === 0) {
      return NextResponse.json({ error: "empty file" }, { status: 422 });
    }

    // Sniff before shipping the file to the sidecar: a PEM "server.key" or a
    // Graphviz ".dot" must never be converted (nor a PDF copy cached). Once a
    // job is running the file already passed, so polls skip the extra RPC.
    if (!jobRunning(cachePath)) {
      const head = await readHead(driveId, drive.drive_secret, path);
      if (!magicMatches(extOf(path), head)) {
        return NextResponse.json({ error: "file content doesn't match its extension" }, { status: 415 });
      }
    }

    const job = ensureJob({
      cachePath, driveId, driveSecret: drive.drive_secret, path,
      size: entry.size, target, converterUrl,
    });
    if (job.state === "failed") return NextResponse.json({ error: job.error }, { status: job.status });
    if (job.state === "busy") {
      return NextResponse.json({ error: "too many conversions in progress" }, { status: 503, headers: { "Retry-After": "10" } });
    }
    return NextResponse.json({ status: "pending" }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}

async function readHead(driveId: string, secret: string, path: string): Promise<Uint8Array> {
  const reader = agentByteStream(driveId, secret, path, 0, MAGIC_BYTES).getReader();
  const out: number[] = [];
  try {
    while (out.length < MAGIC_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(...value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return new Uint8Array(out.slice(0, MAGIC_BYTES));
}
