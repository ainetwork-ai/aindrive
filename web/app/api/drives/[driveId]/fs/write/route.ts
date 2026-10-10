import { NextResponse } from "next/server";
import { z } from "zod";
import { requireDriveRole } from "@/lib/require-access";
import { AgentError, callAgent } from "@/lib/rpc";
import { getOwnerStorageCaps, TIER_PRICE_AIN } from "@/lib/tier";
import { getOwnerUsage, bumpOwnerUsage } from "@/lib/storage-usage.js";
import { dropGenerations } from "@/lib/path-generations.js";
import { zRequiredPath } from "@/lib/zod-helpers";
import {
  BACKSLASH_ERROR, baseRevisionOf, conflictBody, conflictWith, expectedRevision, hasBackslash, withPathLock, type Current,
} from "@/lib/write-guard";

// Default 100 MB so ordinary video/image uploads go through (16 MB rejected most
// videos). This path base64-encodes the whole file into one JSON body, so it's
// memory-bound — true large-file (GB) uploads want a streamed/chunked transfer
// to the agent (follow-up). Override per deployment via AINDRIVE_MAX_WRITE_BYTES.
const MAX_WRITE_BYTES = parseInt(process.env.AINDRIVE_MAX_WRITE_BYTES ?? String(100 * 1024 * 1024), 10);

const Body = z.object({
  path: zRequiredPath,
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).optional(),
  /**
   * Optional optimistic concurrency (lib/write-guard.ts): the revision the
   * writer last read (`m<mtimeMs>-s<size>`, a listing's `-g<gen>` suffix is
   * ignored), or "none" to create only. Also accepted as `If-Match` /
   * `If-None-Match: *`. A mismatch answers 409 `conflict` + currentRevision.
   */
  baseRevision: z.string().max(200).optional(),
  /** Who is writing (diagnostics only, logged by the agent when the write
   *  changes a file inside a git working tree): "autosave" | "user-save" | … */
  source: z.string().max(32).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const gate = await requireDriveRole(driveId, body.data.path, { min: "editor" });
  if (gate instanceof NextResponse) return gate;
  const { drive } = gate;
  const { content, encoding } = body.data;
  const byteLength = encoding === "base64"
    ? Math.ceil(content.length * 3 / 4)
    : Buffer.byteLength(content, "utf8");
  if (byteLength > MAX_WRITE_BYTES) {
    return NextResponse.json(
      { error: "payload too large", limit: MAX_WRITE_BYTES },
      { status: 413, headers: { "X-Max-Bytes": String(MAX_WRITE_BYTES) } },
    );
  }
  if (hasBackslash(body.data.path)) return NextResponse.json({ error: BACKSLASH_ERROR }, { status: 400 });
  const expected = expectedRevision(body.data.baseRevision, req.headers);
  // One write of a path at a time (lib/write-guard.ts): the stat, the
  // revision check and the write below see no other writer in between.
  return withPathLock(driveId, body.data.path, async () => {
    // Tiered file-count cap (per owner, summed across all of their drives).
    // Only enforce on file creation — overwrites of existing files don't bump
    // the count. The agent's stat matches the path in either Unicode spelling
    // (an NFD name a Mac made is the same file). The cap is the drive owner's
    // (their tier, or AINDRIVE_UNLIMITED_OWNERS), not the caller's.
    const ownerId = drive.owner_id as string;
    const { tier, fileLimit } = getOwnerStorageCaps(ownerId);
    let current: Current = { exists: false };
    try {
      const st = await callAgent(driveId, drive.drive_secret, { method: "stat", path: body.data.path });
      if (st.entry) current = { exists: true, isDir: !!st.entry.isDir, revision: baseRevisionOf(st.entry) };
    } catch (e) {
      // Without a stat a conditional write cannot be checked; say so instead of guessing.
      if (expected !== null) {
        const err = e as AgentError;
        return NextResponse.json({ error: err.message }, { status: err.status ?? 502 });
      }
    }
    const conflict = conflictWith(expected, current);
    if (conflict) return NextResponse.json(conflictBody(conflict.currentRevision), { status: 409 });
    const creating = !current.exists || current.isDir;
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
    try {
      const result = await callAgent(driveId, drive.drive_secret, {
        method: "write", path: body.data.path, content, encoding: body.data.encoding, source: body.data.source,
      });
      if (creating) {
        bumpOwnerUsage(ownerId, { files: 1 });
        dropGenerations(driveId, body.data.path); // a new file: no old ref names it (task 10.2)
      }
      // The revision the writer now holds, for its next conditional write.
      let revision: string | undefined;
      try {
        const st = await callAgent(driveId, drive.drive_secret, { method: "stat", path: body.data.path });
        if (st.entry && !st.entry.isDir) revision = baseRevisionOf(st.entry);
      } catch { /* the write itself succeeded */ }
      return NextResponse.json(revision ? { ...result, revision } : result);
    } catch (e) {
      const err = e as AgentError;
      return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
    }
  });
}

