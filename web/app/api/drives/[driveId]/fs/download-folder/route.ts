import { NextResponse } from "next/server";
import { requireDriveRole } from "@/lib/require-access";
import { getDrive, type DriveRow } from "@/lib/drives";
import { AgentError, callAgent } from "@/lib/rpc";
import { normalizePath, type NormalizedPath } from "@/lib/path";
import { readDownloadToken, signDownloadToken } from "@/lib/download-token";
import {
  lockedDescendants, zipFolderOnAgent, zipFilename, zipHeaders, zipResponse, zipErrorStatus, zipTempPath,
} from "@/lib/download-folder";

/**
 * GET /api/drives/:driveId/fs/download-folder?path=<dir>
 *
 * Downloads a folder as `<folder>.zip` — the folder twin of fs/download. The
 * drive's agent zips the folder to a temp file (cli/src/zip-folder.js: no
 * `.aindrive/`, `.git/`, bare remotes or `node_modules`; a repo folder yields
 * its working tree), the web streams it with download-chunk and deletes it.
 *
 * Access: viewer+ at the folder through requireDriveRole, like fs/download —
 * a locked (unbought) folder is a 402 before the agent is asked for anything.
 * Inside a readable folder, every paid child this caller may not read
 * (lib/listing-visibility.ts: shown locked or hidden by fs/list) is left out
 * of the zip; `X-Aindrive-Skipped` counts those entries, `X-Aindrive-Files`
 * the files archived. Caps on the agent (20 000 files / 2 GiB) answer 413.
 *
 * Three shapes:
 *   ?path=<dir>              zip, then stream — one request (API clients, curl).
 *   ?path=<dir>&prepare=1    zip now, answer JSON { url, filename, size, files, skipped }:
 *                            the UI shows "preparing…" during this call, then navigates
 *                            to `url`, which carries a folder download token bound to
 *                            the prepared zip (lib/download-token.ts).
 *   ?path=<dir>&dt=<token>   stream that prepared zip (cookieless like fs/download's
 *                            token path; the zip already reflects the minter's locks).
 */
export async function GET(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const url = new URL(req.url);
  const rawPath = url.searchParams.get("path");
  if (rawPath === null) return NextResponse.json({ error: "path required" }, { status: 400 });
  let path: NormalizedPath;
  try { path = normalizePath(rawPath); }
  catch { return NextResponse.json({ error: "invalid path" }, { status: 400 }); }

  const dt = url.searchParams.get("dt");
  if (dt) {
    const claims = await readDownloadToken(dt, driveId, path, "folder");
    if (!claims?.job) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const drive = getDrive(driveId);
    if (!drive) return NextResponse.json({ error: "not found" }, { status: 404 });
    try {
      const st = await callAgent(driveId, drive.drive_secret, { method: "stat", path: zipTempPath(claims.job) }) as
        { entry: { size: number; isDir: boolean } | null };
      if (!st.entry || st.entry.isDir) return NextResponse.json({ error: "download expired" }, { status: 410 });
      return zipResponse(driveId, drive.drive_secret, claims.job, st.entry.size, zipHeaders(zipFilename(path, drive.name), st.entry.size));
    } catch (e) {
      const err = e as AgentError;
      return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
    }
  }

  // Cookie, or a session JWT as bearer (same gate as fs/download).
  const gate = await requireDriveRole(driveId, path, { min: "viewer", req });
  if (gate instanceof NextResponse) return gate;
  const drive: DriveRow = gate.drive;

  try {
    const stat = await callAgent(driveId, drive.drive_secret, { method: "stat", path }) as
      { entry: { size: number; isDir: boolean } | null };
    if (!stat.entry || !stat.entry.isDir) return NextResponse.json({ error: "not found" }, { status: 404 });

    const exclude = lockedDescendants(driveId, path, gate.role, gate.userId);
    const zip = await zipFolderOnAgent(driveId, drive.drive_secret, path, exclude);
    const filename = zipFilename(path, drive.name);

    if (url.searchParams.get("prepare")) {
      const token = await signDownloadToken(driveId, path, { kind: "folder", job: zip.job });
      return NextResponse.json({
        url: `/api/drives/${driveId}/fs/download-folder?path=${encodeURIComponent(path)}&dt=${encodeURIComponent(token)}`,
        filename, size: zip.size, files: zip.files, bytes: zip.bytes, skipped: zip.skipped,
      }, { headers: { "cache-control": "private, no-store" } });
    }
    return zipResponse(driveId, drive.drive_secret, zip.job, zip.size, zipHeaders(filename, zip.size, { files: zip.files, skipped: zip.skipped }));
  } catch (e) {
    const err = e as AgentError;
    const status = zipErrorStatus(e);
    return NextResponse.json({ error: status === 413 ? "folder too large to download as one zip (limit 20 000 files / 2 GiB)" : err.message }, { status });
  }
}
