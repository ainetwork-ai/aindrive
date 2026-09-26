import { NextResponse } from "next/server";
import { requireDriveRole } from "@/lib/require-access";
import { AgentError, callAgent } from "@/lib/rpc";
import { normalizePath } from "@/lib/path";
import { classifyKind } from "@/lib/mime";
import { bytesFor, cachedOnly, cachedSize, noteStat } from "@/lib/media/cache"; // verified chunk cache, or straight from the agent
import { servedBytesHeaders } from "@/lib/served-bytes";

/**
 * GET /api/drives/:driveId/fs/stream?path=...
 *
 * Range-aware inline byte streaming for in-browser media playback. fs/read's
 * base64 JSON path is capped (and the agent silently truncates reads at
 * 8 MiB), which is why large videos "previewed" as broken files — this route
 * streams download-chunk RPCs instead, and honoring Range is what lets
 * <video> seek without downloading the whole file.
 *
 * Same viewer+ gate as fs/read. The "save to disk" twin is fs/download.
 *
 * XSS containment: this URL renders INLINE on the app origin and uploads come
 * from any editor, so the type is served by lib/served-bytes.ts's policy.
 */

export async function GET(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const url = new URL(req.url);
  const rawPath = url.searchParams.get("path");
  if (!rawPath) return NextResponse.json({ error: "path required" }, { status: 400 });
  let path: string;
  try { path = normalizePath(rawPath); }
  catch { return NextResponse.json({ error: "invalid path" }, { status: 400 }); }

  // Cookie, or a session JWT as bearer (server-side asset proxies, docs/AINUI.md §2).
  const gate = await requireDriveRole(driveId, path, { min: "viewer", req });
  if (gate instanceof NextResponse) return gate;
  const { drive } = gate;

  try {
    // The device may be asleep: then serve from the verified cache what it already holds.
    type Stat = { entry: { size: number; mtimeMs: number; isDir: boolean } | null };
    let stat = null as Stat | null;
    let offlineSize: number | null = null;
    try {
      stat = (await callAgent(driveId, drive.drive_secret, { method: "stat", path })) as unknown as Stat;
    } catch (e) {
      offlineSize = (e as AgentError).status === 504 || (e as AgentError).status === 502 ? cachedSize(driveId, path) : null;
      if (offlineSize === null) throw e;
    }
    if (stat) noteStat(driveId, path, stat.entry && !stat.entry.isDir ? stat.entry : null); // a changed or deleted file forgets its offline manifest
    if (stat && (!stat.entry || stat.entry.isDir)) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const size = stat?.entry ? stat.entry.size : offlineSize!;
    const { mime } = classifyKind(path);

    // Range grammar (single range only — multipart ranges are not worth the
    // complexity for media playback): bytes=a-b | bytes=a- | bytes=-n
    let start = 0;
    let endExclusive = size;
    let status = 200;
    const range = req.headers.get("range");
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      const first = m?.[1] ?? "";
      const last = m?.[2] ?? "";
      if (!m || (first === "" && last === "")) {
        return NextResponse.json({ error: "malformed range" }, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      }
      if (first === "") {
        // suffix form: last n bytes
        const n = Math.min(parseInt(last, 10), size);
        start = size - n;
      } else {
        start = parseInt(first, 10);
        endExclusive = last === "" ? size : Math.min(parseInt(last, 10) + 1, size);
      }
      if (start >= size || start >= endExclusive) {
        return NextResponse.json({ error: "range not satisfiable" }, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      }
      status = 206;
    }

    const headers: Record<string, string> = {
      "Accept-Ranges": "bytes",
      "Content-Length": String(endExclusive - start),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    };
    Object.assign(headers, servedBytesHeaders(mime));
    if (status === 206) headers["Content-Range"] = `bytes ${start}-${endExclusive - 1}/${size}`;

    // 0-byte file: nothing to pull — an empty body avoids a degenerate stream.
    if (endExclusive - start === 0) return new Response(null, { status, headers });
    if (!stat?.entry) {
      const cached = cachedOnly(driveId, path, start, endExclusive);
      if (!cached) return NextResponse.json({ error: "the device is offline and this part is not cached yet" }, { status: 504 });
      return new Response(cached.stream, { status, headers });
    }
    return new Response(await bytesFor(driveId, drive.drive_secret, path, { size, mtimeMs: stat.entry.mtimeMs }, start, endExclusive), { status, headers });
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
