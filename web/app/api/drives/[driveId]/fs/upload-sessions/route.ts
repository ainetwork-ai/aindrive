import { NextResponse } from "next/server";
import { z } from "zod";
import { requireDriveRole } from "@/lib/require-access";
import { getUser } from "@/lib/session";
import { callAgent } from "@/lib/rpc";
import { zPath } from "@/lib/zod-helpers";
import { getUserTier, TIER_FILE_LIMIT, TIER_PRICE_AIN } from "@/lib/tier";
import { getOwnerUsage } from "@/lib/storage-usage.js";
import { createUploadSession, sweepStaleSessions, PART_BYTES } from "@/lib/upload-sessions";

/**
 * POST /api/drives/:driveId/fs/upload-sessions  { path, size }
 *
 * Opens a chunked/resumable upload session (the large-file path; files at or
 * under one part go through the single-POST fs/upload). Returns
 * { uploadId, partSize, receivedBytes } — the client then PATCHes sequential
 * ≤partSize parts to fs/upload-sessions/:uploadId. Gates (size cap, editor
 * role, tier file-count) mirror fs/upload so the two entry points can't
 * disagree about what's allowed.
 */
const MAX_UPLOAD_BYTES = parseInt(process.env.AINDRIVE_MAX_UPLOAD_BYTES ?? String(2 * 1024 * 1024 * 1024), 10);

const Body = z.object({
  path: zPath,
  size: z.number().int().positive(),
});

export async function POST(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const { path, size } = body.data;

  if (size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: "payload too large", limit: MAX_UPLOAD_BYTES },
      { status: 413, headers: { "X-Max-Bytes": String(MAX_UPLOAD_BYTES) } },
    );
  }

  const gate = await requireDriveRole(driveId, path, { min: "editor" });
  if (gate instanceof NextResponse) return gate;
  const { drive } = gate;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Tiered file-count cap — mirrors fs/upload (only file CREATION counts).
  // `creating` is recorded on the session so completion bumps usage correctly
  // even if the target appears/disappears while parts are in flight.
  const ownerId = drive.owner_id as string;
  const { tier } = await getUserTier(req);
  const fileLimit = TIER_FILE_LIMIT[tier];
  let creating = false;
  try {
    const stat = await callAgent(driveId, drive.drive_secret, { method: "stat", path });
    creating = !stat.entry || stat.entry.isDir === true;
  } catch { creating = true; }
  if (creating && Number.isFinite(fileLimit)) {
    const usage = getOwnerUsage(ownerId);
    if (usage.files + 1 > fileLimit) {
      return NextResponse.json(
        {
          error: "file_limit_reached",
          tier,
          limit: fileLimit,
          current: usage.files,
          upgrade: tier === "max" ? null : {
            to: tier === "free" ? "pro" : "max",
            priceAin: tier === "free" ? TIER_PRICE_AIN.pro : TIER_PRICE_AIN.max,
            url: tier === "free"
              ? `/api/x402/lift?scope=tier:pro&priceAin=${TIER_PRICE_AIN.pro}`
              : `/api/x402/lift?scope=tier:max&priceAin=${TIER_PRICE_AIN.max}`,
          },
        },
        { status: 429 },
      );
    }
  }

  // Opportunistic GC of this drive's stale sessions — keeps abandoned temps
  // from accumulating without a background job.
  await sweepStaleSessions(driveId, drive.drive_secret);

  const session = createUploadSession({ driveId, path, size, isCreating: creating, userId: user.id });
  return NextResponse.json({
    uploadId: session.id,
    partSize: PART_BYTES,
    receivedBytes: 0,
  });
}
