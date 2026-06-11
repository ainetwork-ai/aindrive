import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { requireDriveRole } from "@/lib/require-access";
import { AgentError, callAgent } from "@/lib/rpc";
import { normalizePath } from "@/lib/path";
import { getUserTier, TIER_FILE_LIMIT, TIER_PRICE_AIN } from "@/lib/tier";
import { getOwnerUsage, bumpOwnerUsage } from "@/lib/storage-usage.js";

/**
 * POST /api/drives/:driveId/fs/upload?path=...
 *
 * Single-POST upload: raw octet-stream body (NOT base64 JSON — that
 * path buffers the whole file in memory on both ends and caps at
 * AINDRIVE_MAX_WRITE_BYTES). The web client uses this only for files at or
 * under one part (8 MiB); larger files go through the chunked/resumable
 * fs/upload-sessions flow, which a single giant POST can't match (proxy body
 * caps, request timeouts, no resume). The body is re-chunked to the agent's 4 MiB
 * upload-chunk limit and forwarded sequentially (each RPC awaited = natural
 * backpressure) into a hidden temp file (.aindrive/uploads/<id>.part — the
 * .aindrive dir is excluded from listings), then atomically renamed onto the
 * target path. An interrupted upload therefore never leaves a partial file
 * where a complete one should be, and concurrent uploads to the same path
 * can't interleave — distinct temp names, last rename wins (same semantics
 * as fs/write overwrites). Uses only RPCs every deployed agent already has.
 */

// Agent-side maxUploadChunkBytes — keep in sync with cli/src/rpc.js LIMITS.
const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_UPLOAD_BYTES = parseInt(process.env.AINDRIVE_MAX_UPLOAD_BYTES ?? String(2 * 1024 * 1024 * 1024), 10);

export async function POST(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const url = new URL(req.url);
  const rawPath = url.searchParams.get("path");
  if (!rawPath) return NextResponse.json({ error: "path required" }, { status: 400 });
  let path: string;
  try { path = normalizePath(rawPath); }
  catch { return NextResponse.json({ error: "invalid path" }, { status: 400 }); }

  // Reject oversize uploads before reading a byte when the client declared a
  // length; the streaming loop still enforces the cap for chunked bodies.
  const declared = parseInt(req.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: "payload too large", limit: MAX_UPLOAD_BYTES },
      { status: 413, headers: { "X-Max-Bytes": String(MAX_UPLOAD_BYTES) } },
    );
  }

  const gate = await requireDriveRole(driveId, path, { min: "editor" });
  if (gate instanceof NextResponse) return gate;
  const { drive } = gate;

  // Tiered file-count cap — mirrors fs/write (only file CREATION counts).
  const ownerId = drive.owner_id as string;
  const { tier } = await getUserTier(req);
  const fileLimit = TIER_FILE_LIMIT[tier];
  let creating = false;
  try {
    const stat = await callAgent(driveId, drive.drive_secret, { method: "stat", path }) as
      { entry: { isDir: boolean } | null };
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

  const tmp = `.aindrive/uploads/${nanoid(12)}.part`;
  // Cleanup is best-effort (an offline agent can't delete its own temp) but
  // runs on EVERY non-renamed exit — including client aborts, where the body
  // stream may end with done:true instead of throwing. The temp lives under
  // .aindrive (hidden from listings), so a missed cleanup is invisible junk,
  // not user-facing state. A startup scrubber for stale .part files is a
  // noted follow-up.
  const cleanup = () =>
    callAgent(driveId, drive.drive_secret, { method: "delete", path: tmp }).catch(() => {});

  let renamed = false;
  try {
    let chunkId = 0;
    let total = 0;
    let buf = Buffer.alloc(0);

    const sendChunk = async (data: Buffer) => {
      await callAgent(driveId, drive.drive_secret, {
        // `total` is advisory in the protocol (the agent appends by chunkId);
        // -1 = unknown, kept for forward compatibility.
        method: "upload-chunk", path: tmp, chunkId, total: -1, data: data.toString("base64"),
        // Override the 25s default: appending each 4 MiB chunk to a multi-hundred-MB
        // .part file on a slow/contended disk can exceed it (a GB upload is ~hundreds
        // of sequential chunk RPCs), which surfaced as a large upload dying mid-stream.
      }, { timeoutMs: 120_000 });
      chunkId += 1;
    };

    if (req.body) {
      const reader = req.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_UPLOAD_BYTES) {
          return NextResponse.json(
            { error: "payload too large", limit: MAX_UPLOAD_BYTES },
            { status: 413, headers: { "X-Max-Bytes": String(MAX_UPLOAD_BYTES) } },
          );
        }
        buf = Buffer.concat([buf, Buffer.from(value)]);
        while (buf.length >= CHUNK_BYTES) {
          await sendChunk(buf.subarray(0, CHUNK_BYTES));
          buf = buf.subarray(CHUNK_BYTES);
        }
      }
    }

    // A client abort may surface as a CLEAN end-of-stream (done:true) rather
    // than a thrown error — renaming then would publish a silently truncated
    // file at the target, which is exactly what the temp+rename design exists
    // to prevent. Likewise reject bodies shorter than their declared length.
    if (req.signal?.aborted) {
      return NextResponse.json({ error: "client aborted upload" }, { status: 499 });
    }
    if (Number.isFinite(declared) && total !== declared) {
      return NextResponse.json(
        { error: `body ended early (${total} of ${declared} bytes)` },
        { status: 400 },
      );
    }

    // Flush the tail. chunkId 0 with empty data still creates the file, so
    // zero-byte uploads work; for anything already chunked an empty tail is
    // skipped (nothing left to append).
    if (buf.length > 0 || chunkId === 0) await sendChunk(buf);

    // Atomic publish: the target path either keeps its old content or gets
    // the complete new one — never a partial file. Same-volume rename is a
    // metadata op (fast), but give it headroom too for a contended disk.
    await callAgent(driveId, drive.drive_secret, { method: "rename", from: tmp, to: path }, { timeoutMs: 120_000 });
    renamed = true;

    if (creating) bumpOwnerUsage(ownerId, { files: 1 });
    return NextResponse.json({ ok: true, path, bytes: total });
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  } finally {
    if (!renamed) await cleanup();
  }
}
