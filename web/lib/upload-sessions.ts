// Chunked/resumable upload sessions — the server half of the tus-style
// protocol in app/api/drives/[driveId]/fs/upload-sessions/. A session maps an
// uploadId to a hidden agent temp file; clients append sequential parts whose
// declared offset must match received_bytes, and the agent temp's actual size
// (stat) is the recovery truth when a part died mid-append. Why offset-checked
// parts instead of one streaming POST: every proxy/runtime layer (nginx body
// caps, Node requestTimeout, lingering close) limits a single giant request,
// while ≤8 MiB parts pass them all and make resume free.
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { callAgent } from "@/lib/rpc";

export type UploadSession = {
  id: string;
  drive_id: string;
  path: string;
  temp_path: string;
  size: number;
  received_bytes: number;
  is_creating: number;
  created_by: string;
};

// Server-declared part cap. Chosen so one part clears default proxy/runtime
// timeouts even on a slow agent link (8 MiB ≈ 16 s at 0.5 MiB/s < nginx's 60 s
// default), while keeping per-part HTTP overhead negligible for GB files.
export const PART_BYTES = 8 * 1024 * 1024;
// Agent-side maxUploadChunkBytes — keep in sync with cli/src/rpc.js LIMITS.
export const AGENT_CHUNK_BYTES = 4 * 1024 * 1024;
// Sessions older than this are garbage on both ends; swept opportunistically
// on session create (no daemon needed).
const SESSION_TTL_HOURS = 48;

export function createUploadSession(args: {
  driveId: string; path: string; size: number; isCreating: boolean; userId: string;
}): UploadSession {
  const id = nanoid(16);
  const tempPath = `.aindrive/uploads/${id}.part`;
  db.prepare(
    `INSERT INTO upload_sessions (id, drive_id, path, temp_path, size, is_creating, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, args.driveId, args.path, tempPath, args.size, args.isCreating ? 1 : 0, args.userId);
  return getUploadSession(id)!;
}

export function getUploadSession(id: string): UploadSession | null {
  return (db.prepare("SELECT * FROM upload_sessions WHERE id = ?").get(id) as UploadSession | undefined) ?? null;
}

export function setSessionReceivedBytes(id: string, receivedBytes: number) {
  db.prepare("UPDATE upload_sessions SET received_bytes = ?, updated_at = datetime('now') WHERE id = ?")
    .run(receivedBytes, id);
}

export function deleteUploadSession(id: string) {
  db.prepare("DELETE FROM upload_sessions WHERE id = ?").run(id);
}

/**
 * Drop sessions idle past the TTL and (best-effort) their agent temp files.
 * Called opportunistically from session create — an offline agent just means
 * the orphan .part waits for a later sweep or stays as hidden junk under
 * .aindrive (invisible to listings).
 */
export async function sweepStaleSessions(driveId: string, driveSecret: string) {
  const stale = db.prepare(
    `SELECT id, temp_path FROM upload_sessions
     WHERE drive_id = ? AND updated_at < datetime('now', ?)`,
  ).all(driveId, `-${SESSION_TTL_HOURS} hours`) as { id: string; temp_path: string }[];
  for (const s of stale) {
    deleteUploadSession(s.id);
    await callAgent(driveId, driveSecret, { method: "delete", path: s.temp_path }).catch(() => {});
  }
}

/**
 * The agent temp's actual byte count — the recovery truth after a part died
 * mid-append (DB says N, agent already has N + k·4MiB). null = file absent
 * (nothing appended yet, or the temp was lost).
 */
export async function statAgentTempBytes(
  driveId: string, driveSecret: string, tempPath: string,
): Promise<number | null> {
  const res = await callAgent(driveId, driveSecret, { method: "stat", path: tempPath });
  return res.entry && !res.entry.isDir ? res.entry.size : null;
}

/**
 * Append one part's bytes to the agent temp at absolute `offset`, re-chunked
 * to the agent's 4 MiB RPC limit, sequentially (each await = backpressure).
 * chunkId 0 truncates on the agent, so it is sent ONLY when writing at
 * absolute offset 0 — which also makes a retry of the very first part safe
 * (it rewrites instead of double-appending).
 */
export async function appendPartToAgent(
  driveId: string, driveSecret: string, tempPath: string, offset: number, part: Buffer,
): Promise<void> {
  let written = 0;
  while (written < part.length || (part.length === 0 && offset === 0)) {
    const slice = part.subarray(written, written + AGENT_CHUNK_BYTES);
    await callAgent(driveId, driveSecret, {
      method: "upload-chunk",
      path: tempPath,
      chunkId: offset + written === 0 ? 0 : 1,
      total: -1, // advisory in the protocol; the agent appends by chunkId
      data: slice.toString("base64"),
      // Headroom over the 25s default: a 4 MiB append on a contended/slow
      // agent disk (dirty-page flush stalls) can take tens of seconds.
    }, { timeoutMs: 120_000 });
    written += slice.length;
    if (part.length === 0) break; // zero-byte create: one empty chunk 0
  }
}

// One PATCH in flight per session. Without this, two concurrent parts (e.g. a
// retry racing its original) would interleave appends and corrupt the temp —
// the offset check alone can't catch a race that starts before either commits.
// In-memory is sufficient: the WS agent registry already pins a drive's
// traffic to this single server process.
const inFlight = new Set<string>();
export function lockSession(id: string): boolean {
  if (inFlight.has(id)) return false;
  inFlight.add(id);
  return true;
}
export function unlockSession(id: string) {
  inFlight.delete(id);
}
