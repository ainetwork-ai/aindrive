import { NextResponse } from "next/server";
import { requireDriveRole } from "@/lib/require-access";
import { normalizePath } from "@/lib/path";
import { signDownloadToken } from "@/lib/download-token";

/**
 * GET /api/drives/:driveId/fs/download-token?path=...
 *
 * Mints a short-lived, path-scoped download capability for a single file.
 * Cookie-authenticated behind the SAME viewer+ gate as fs/download, so it can
 * only be obtained by someone already allowed to download this file — the token
 * never grants more than the minter had.
 *
 * The viewer calls this (a cookie-carrying fetch, so it passes the gate) and
 * appends the returned token to the fs/download URL. That lets the actual byte
 * download succeed even when it runs in a context that drops the session
 * cookie — an in-app mobile webview handing the attachment off to a separate OS
 * downloader. See lib/download-token.ts.
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

  const token = await signDownloadToken(driveId, path);
  return NextResponse.json({
    url: `/api/drives/${driveId}/fs/download?path=${encodeURIComponent(path)}&dt=${encodeURIComponent(token)}`,
  });
}
