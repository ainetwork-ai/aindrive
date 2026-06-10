import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { NextResponse } from "next/server";
import sharp from "sharp";
import { requireDriveRole } from "@/lib/require-access";
import { AgentError, callAgent } from "@/lib/rpc";
import { normalizePath } from "@/lib/path";
import { classifyKind } from "@/lib/mime";

/**
 * GET /api/drives/:driveId/fs/thumbnail?path=...&v=<mtimeMs>
 *
 * Grid-card thumbnail for image files. The original is pulled from the agent
 * ONCE, resized to 256px webp, and cached on disk keyed by sha1(path)+mtime —
 * editing the file changes the key, so stale thumbs are never served (old
 * keys linger; they're tens of KB, GC is a follow-up). `v` is ignored here:
 * it exists so the browser's immutable cache re-fetches when mtime changes.
 *
 * Same auth gate as fs/read (viewer or better). Failures map to statuses the
 * grid treats as "fall back to the type icon" — never a broken layout.
 */

const THUMB_W = 256;
const MAX_READ_BYTES = parseInt(process.env.AINDRIVE_MAX_READ_BYTES ?? String(16 * 1024 * 1024), 10);

// Mirrors lib/db.js dataDir (not exported there).
function thumbsDir(driveId: string): string {
  return join(process.env.AINDRIVE_DATA_DIR || join(homedir(), ".aindrive"), "thumbs", driveId);
}

function imgResponse(buf: Buffer, contentType = "image/webp"): NextResponse {
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": contentType,
      // Immutable is safe: the URL carries &v=<mtimeMs>, so content changes
      // produce a different URL.
      "Cache-Control": "private, max-age=31536000, immutable",
      // SVG can carry scripts — sandbox neutralizes them if one is ever
      // opened as a top-level document instead of an <img>.
      ...(contentType === "image/svg+xml" ? { "Content-Security-Policy": "sandbox" } : {}),
    },
  });
}

export async function GET(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const url = new URL(req.url);
  const rawPath = url.searchParams.get("path");
  if (!rawPath) return NextResponse.json({ error: "path required" }, { status: 400 });
  let path: string;
  try { path = normalizePath(rawPath); }
  catch { return NextResponse.json({ error: "invalid path" }, { status: 400 }); }

  const { mime } = classifyKind(path);
  if (!mime.startsWith("image/")) {
    return NextResponse.json({ error: "not an image" }, { status: 415 });
  }
  const isSvg = mime === "image/svg+xml";

  const gate = await requireDriveRole(driveId, path, { min: "viewer" });
  if (gate instanceof NextResponse) return gate;
  const { drive } = gate;

  try {
    // stat first: cheap, and its mtime keys the cache so a hit skips the
    // (much heavier) read RPC entirely.
    const stat = await callAgent(driveId, drive.drive_secret, { method: "stat", path }) as
      { entry: { mtimeMs: number; size: number; isDir: boolean } | null };
    if (!stat.entry || stat.entry.isDir) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    if (stat.entry.size > MAX_READ_BYTES) {
      return NextResponse.json({ error: "file too large for a thumbnail", limit: MAX_READ_BYTES }, { status: 413 });
    }

    const dir = thumbsDir(driveId);
    const key = `${createHash("sha1").update(path).digest("hex")}-${stat.entry.mtimeMs}.${isSvg ? "svg" : "webp"}`;
    const cached = join(dir, key);
    if (existsSync(cached)) {
      return imgResponse(readFileSync(cached), isSvg ? "image/svg+xml" : "image/webp");
    }

    const result = await callAgent(driveId, drive.drive_secret, { method: "read", path, encoding: "base64" }) as
      { content: string };
    const original = Buffer.from(result.content, "base64");

    // SVG passes through untouched (vector — already small to render);
    // raster images are EXIF-rotated and downscaled to a 256px webp.
    let out: Buffer;
    try {
      out = isSvg
        ? original
        : await sharp(original)
            .rotate()
            .resize({ width: THUMB_W, height: THUMB_W, fit: "inside", withoutEnlargement: true })
            .webp({ quality: 78 })
            .toBuffer();
    } catch {
      return NextResponse.json({ error: "could not decode image" }, { status: 422 });
    }

    mkdirSync(dir, { recursive: true });
    writeFileSync(cached, out);
    return imgResponse(out, isSvg ? "image/svg+xml" : "image/webp");
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
