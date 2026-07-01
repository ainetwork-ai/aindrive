import { NextResponse } from "next/server";
import { requireDriveRole } from "@/lib/require-access";
import { getDrive, type DriveRow } from "@/lib/drives";
import { AgentError, callAgent } from "@/lib/rpc";
import { normalizePath } from "@/lib/path";
import { classifyKind, basenameForDownload } from "@/lib/mime";
import { agentByteStream } from "@/lib/agent-stream";
import { verifyDownloadToken } from "@/lib/download-token";

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

  // Authorize by cookie (normal) OR a short-lived signed download token in the
  // URL. The token path exists for byte fetches that can't carry the session
  // cookie — an in-app mobile webview hands a Content-Disposition: attachment
  // navigation to a separate OS downloader with no cookies, so the cookie gate
  // would 403 a user who can otherwise stream/view the file. The token is minted
  // by fs/download-token behind the SAME viewer+ cookie gate, so it never grants
  // more than the minter already had. No token -> behaviour is unchanged.
  const dt = url.searchParams.get("dt");
  let drive: DriveRow;
  if (dt && (await verifyDownloadToken(dt, driveId, path))) {
    const d = getDrive(driveId);
    if (!d) return NextResponse.json({ error: "not found" }, { status: 404 });
    drive = d;
  } else {
    const gate = await requireDriveRole(driveId, path, { min: "viewer" });
    if (gate instanceof NextResponse) return gate;
    drive = gate.drive;
  }

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
      // attachment disposition is the XSS guard here; nosniff backs it up.
      "x-content-type-options": "nosniff",
    };
    if (size === 0) return new Response(null, { status: 200, headers });
    return new Response(agentByteStream(driveId, drive.drive_secret, path, 0, size), { status: 200, headers });
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
