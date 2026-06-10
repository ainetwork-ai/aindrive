import { NextResponse } from "next/server";
import { requireDriveRole } from "@/lib/require-access";
import { AgentError, callAgent } from "@/lib/rpc";
import { normalizePath } from "@/lib/path";
import { classifyKind, basenameForDownload } from "@/lib/mime";
import { agentByteStream } from "@/lib/agent-stream";

/**
 * GET /api/drives/:driveId/fs/download?path=...
 *
 * Streams the raw bytes of a single file with proper Content-Type and
 * Content-Disposition: attachment headers, so browsers (and AI agents)
 * can download images / PDFs / archives directly. The fs/read endpoint
 * exists for in-browser viewers; this endpoint exists for "save to disk".
 *
 * Access: viewer+ via the same resolveAccess() gate as fs/read.
 *
 * Implementation: chunked download-chunk RPCs wrapped in a ReadableStream —
 * no size cap, nothing buffered whole. (The old single-read version was
 * capped at 16 MB and the agent silently truncated reads at 8 MiB, which
 * corrupted big downloads.) fs/stream is the inline/Range twin for playback.
 */
export async function GET(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const url = new URL(req.url);
  const rawPath = url.searchParams.get("path");
  if (!rawPath) return NextResponse.json({ error: "path required" }, { status: 400 });
  let path: string;
  try { path = normalizePath(rawPath); }
  catch { return NextResponse.json({ error: "invalid path" }, { status: 400 }); }

  const gate = await requireDriveRole(driveId, path, { min: "viewer" });
  if (gate instanceof NextResponse) return gate;
  const { drive } = gate;

  try {
    const stat = await callAgent(driveId, drive.drive_secret, { method: "stat", path }) as
      { entry: { size: number; isDir: boolean } | null };
    if (!stat.entry || stat.entry.isDir) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const size = stat.entry.size;
    const { mime } = classifyKind(path);
    const filename = basenameForDownload(path) || "file";
    const headers = {
      "content-type": mime,
      // RFC 6266: filename* for non-ASCII names, filename for legacy clients.
      "content-disposition": `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "content-length": String(size),
      "cache-control": "private, no-store",
    };
    if (size === 0) return new Response(null, { status: 200, headers });
    return new Response(agentByteStream(driveId, drive.drive_secret, path, 0, size), { status: 200, headers });
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
