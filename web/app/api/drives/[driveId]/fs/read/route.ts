import { NextResponse } from "next/server";
import { requireDriveRole } from "@/lib/require-access";
import { AgentError, callAgent } from "@/lib/rpc";
import { normalizePath } from "@/lib/path";
import { classifyKind } from "@/lib/mime";

const MAX_READ_BYTES = parseInt(process.env.AINDRIVE_MAX_READ_BYTES ?? String(16 * 1024 * 1024), 10);

/**
 * GET /api/drives/:driveId/fs/read?path=...&encoding=auto|utf8|base64
 *
 * Default encoding is `auto`: the server inspects the file's mime type and
 * picks utf8 for text files / base64 for binary. The response body always
 * carries `{ content, encoding, mime }` so clients can branch on it without
 * having to repeat the same decision.
 *
 * `encoding=utf8` / `encoding=base64` force the transport, matching the
 * pre-existing API used by viewer.tsx.
 */
export async function GET(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const url = new URL(req.url);
  const rawPath = url.searchParams.get("path");
  if (!rawPath) return NextResponse.json({ error: "path required" }, { status: 400 });
  let path: string;
  try { path = normalizePath(rawPath); }
  catch { return NextResponse.json({ error: "invalid path" }, { status: 400 }); }

  const encodingParam = url.searchParams.get("encoding") ?? "auto";
  const classified = classifyKind(path);
  let encoding: "utf8" | "base64";
  if (encodingParam === "base64") encoding = "base64";
  else if (encodingParam === "utf8") encoding = "utf8";
  else encoding = classified.kind === "binary" ? "base64" : "utf8";

  const gate = await requireDriveRole(driveId, path, { min: "viewer" });
  if (gate instanceof NextResponse) return gate;
  const { drive } = gate;
  try {
    const result = await callAgent(driveId, drive.drive_secret, { method: "read", path, encoding });
    if (result && typeof result.content === "string") {
      const byteLength = encoding === "base64"
        ? Math.ceil(result.content.length * 3 / 4)
        : Buffer.byteLength(result.content, "utf8");
      if (byteLength > MAX_READ_BYTES) {
        return NextResponse.json(
          { error: "file too large to stream", limit: MAX_READ_BYTES, size: byteLength },
          { status: 413 },
        );
      }
    }
    return NextResponse.json({ ...result, encoding, mime: classified.mime });
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
