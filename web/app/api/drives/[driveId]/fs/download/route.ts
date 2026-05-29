import { NextResponse } from "next/server";
import { requireDriveRole } from "@/lib/require-access";
import { AgentError, callAgent } from "@/lib/rpc";
import { normalizePath } from "@/lib/path";
import { classifyKind, basenameForDownload } from "@/lib/mime";

const MAX_READ_BYTES = parseInt(process.env.AINDRIVE_MAX_READ_BYTES ?? String(16 * 1024 * 1024), 10);

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
 * Implementation: asks the CLI agent for base64 (always), then decodes
 * server-side and returns a Buffer-backed Response with the correct
 * Content-Type. v1 buffers the file in memory — large-file streaming is
 * a Phase-2 follow-up if MAX_READ_BYTES becomes a real constraint.
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
    const result = await callAgent(driveId, drive.drive_secret, { method: "read", path, encoding: "base64" });
    if (!result || typeof result.content !== "string") {
      return NextResponse.json({ error: "agent returned no content" }, { status: 502 });
    }
    const byteLength = Math.ceil(result.content.length * 3 / 4);
    if (byteLength > MAX_READ_BYTES) {
      return NextResponse.json(
        { error: "file too large to stream", limit: MAX_READ_BYTES, size: byteLength },
        { status: 413 },
      );
    }
    const buf = Buffer.from(result.content, "base64");
    const { mime } = classifyKind(path);
    const filename = basenameForDownload(path) || "file";
    return new Response(buf, {
      status: 200,
      headers: {
        "content-type": mime,
        // RFC 6266: filename* for non-ASCII names, filename for legacy clients.
        "content-disposition": `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "content-length": String(buf.length),
        "cache-control": "private, no-store",
      },
    });
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
