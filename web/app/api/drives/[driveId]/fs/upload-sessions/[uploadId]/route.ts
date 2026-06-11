import { NextResponse } from "next/server";
import { requireDriveRole } from "@/lib/require-access";
import { getUser } from "@/lib/session";
import { AgentError, callAgent } from "@/lib/rpc";
import { bumpOwnerUsage } from "@/lib/storage-usage.js";
import {
  getUploadSession, setSessionReceivedBytes, deleteUploadSession,
  statAgentTempBytes, appendPartToAgent, lockSession, unlockSession,
  PART_BYTES, type UploadSession,
} from "@/lib/upload-sessions";

/**
 * One upload session (created by POST ../upload-sessions).
 *
 *   GET    → { receivedBytes, size, path, partSize }   reconciled resume point
 *   PATCH  → append one part; raw body ≤ partSize, header
 *            X-Upload-Offset MUST equal the server's receivedBytes (else 409
 *            with the authoritative value — tus semantics). The part that
 *            reaches `size` triggers the atomic temp→target rename. A
 *            zero-byte PATCH at offset == size retries just the rename (for
 *            when every part landed but the final rename failed).
 *   DELETE → abort: drop the agent temp + the session row.
 *
 * Recovery invariant: the agent temp's stat size — not the DB — is the truth
 * after a crash. PATCH/GET reconcile the DB to it before anything else, so a
 * part that died mid-append (agent has N+k·4MiB, DB says N) never gets
 * double-appended; the client just re-slices from the returned offset.
 */

type Ctx = { params: Promise<{ driveId: string; uploadId: string }> };

// Shared gate: session exists, caller has editor at the session's path, and
// is the session's creator (another editor appending would interleave parts).
type Gate =
  | { error: NextResponse }
  | { session: UploadSession; drive: import("@/lib/drives").DriveRow };
async function gateSession(driveId: string, uploadId: string): Promise<Gate> {
  const session = getUploadSession(uploadId);
  if (!session || session.drive_id !== driveId) {
    return { error: NextResponse.json({ error: "upload session not found" }, { status: 404 }) };
  }
  const gate = await requireDriveRole(driveId, session.path, { min: "editor" });
  if (gate instanceof NextResponse) return { error: gate };
  const user = await getUser();
  if (!user || user.id !== session.created_by) {
    return { error: NextResponse.json({ error: "not this session's owner" }, { status: 403 }) };
  }
  return { session, drive: gate.drive };
}

// DB → agent reconciliation. The temp's stat size is the truth while it
// exists; when it is ABSENT the meaning is ambiguous, so disambiguate instead
// of guessing an offset:
//  - "published": every byte had landed and the TARGET now exists at the
//    declared size — the final rename succeeded but its response was lost.
//    Resetting to 0 here would re-upload onto an already-published file.
//  - "lost": the temp truly vanished (agent wipe, or even a transient stat
//    error — indistinguishable from here). The session is unrecoverable;
//    purging it (→ client opens a fresh session/temp) is safe, whereas
//    resuming would chunkId-0-truncate whatever the stat failed to see.
type SessionState =
  | { kind: "active"; receivedBytes: number }
  | { kind: "published" }
  | { kind: "lost" };

async function resolveState(session: UploadSession, driveSecret: string): Promise<SessionState> {
  const agentBytes = await statAgentTempBytes(session.drive_id, driveSecret, session.temp_path);
  if (agentBytes !== null) {
    if (agentBytes !== session.received_bytes) setSessionReceivedBytes(session.id, agentBytes);
    return { kind: "active", receivedBytes: agentBytes };
  }
  if (session.received_bytes === 0) return { kind: "active", receivedBytes: 0 }; // nothing written yet
  if (session.received_bytes === session.size) {
    const target = await callAgent(session.drive_id, driveSecret, { method: "stat", path: session.path });
    if (target.entry && !target.entry.isDir && target.entry.size === session.size) {
      return { kind: "published" };
    }
  }
  return { kind: "lost" };
}

// "published" closes the session out: the prior request died between the
// agent-side rename and its bookkeeping (bump + row delete are adjacent sync
// ops after the rename await), so neither ran — run them here, exactly once.
function finishPublished(session: UploadSession, ownerId: string) {
  if (session.is_creating) bumpOwnerUsage(ownerId, { files: 1 });
  deleteUploadSession(session.id);
  return NextResponse.json({ complete: true, receivedBytes: session.size, path: session.path });
}

function finishLost(session: UploadSession) {
  deleteUploadSession(session.id);
  return NextResponse.json(
    { error: "upload temp lost — start a new session" },
    { status: 410 },
  );
}

export async function GET(_req: Request, { params }: Ctx) {
  const { driveId, uploadId } = await params;
  const g = await gateSession(driveId, uploadId);
  if ("error" in g) return g.error;
  try {
    const state = await resolveState(g.session, g.drive.drive_secret);
    if (state.kind === "lost") return finishLost(g.session);
    // "published" reports size; the client's zero-byte finalize PATCH then
    // lands in finishPublished. "active" reports the reconciled offset.
    const receivedBytes = state.kind === "published" ? g.session.size : state.receivedBytes;
    return NextResponse.json({
      receivedBytes, size: g.session.size, path: g.session.path, partSize: PART_BYTES,
    });
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message || "agent unreachable" }, { status: err.status ?? 503 });
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  const { driveId, uploadId } = await params;
  const g = await gateSession(driveId, uploadId);
  if ("error" in g) return g.error;
  const { session, drive } = g;

  const declaredOffset = parseInt(req.headers.get("x-upload-offset") ?? "", 10);
  if (!Number.isFinite(declaredOffset) || declaredOffset < 0) {
    return NextResponse.json({ error: "X-Upload-Offset header required" }, { status: 400 });
  }

  if (!lockSession(session.id)) {
    return NextResponse.json({ error: "another part is in flight" }, { status: 409 });
  }
  try {
    const state = await resolveState(session, drive.drive_secret);
    if (state.kind === "published") return finishPublished(session, drive.owner_id as string);
    if (state.kind === "lost") return finishLost(session);
    const receivedBytes = state.receivedBytes;
    if (declaredOffset !== receivedBytes) {
      // Client's view is stale (a retry after a mid-append crash, or a dup).
      // 409 + the authoritative offset; the client re-slices and continues.
      return NextResponse.json(
        { error: "offset mismatch", receivedBytes },
        { status: 409 },
      );
    }

    const part = Buffer.from(await req.arrayBuffer());
    if (part.length > PART_BYTES) {
      return NextResponse.json({ error: "part too large", partSize: PART_BYTES }, { status: 413 });
    }
    if (receivedBytes + part.length > session.size) {
      return NextResponse.json({ error: "part overflows declared size" }, { status: 400 });
    }
    // Zero-byte part is only the rename-retry signal (offset == size); an
    // empty part mid-upload is a client bug, not progress.
    if (part.length === 0 && receivedBytes !== session.size) {
      return NextResponse.json({ error: "empty part" }, { status: 400 });
    }

    if (part.length > 0) {
      await appendPartToAgent(driveId, drive.drive_secret, session.temp_path, receivedBytes, part);
      setSessionReceivedBytes(session.id, receivedBytes + part.length);
    }
    const total = receivedBytes + part.length;
    if (total < session.size) {
      return NextResponse.json({ complete: false, receivedBytes: total });
    }

    // Final part (or rename retry): atomic publish — the target either keeps
    // its old content or gets the complete new one, never a partial file.
    await callAgent(driveId, drive.drive_secret,
      { method: "rename", from: session.temp_path, to: session.path },
      { timeoutMs: 120_000 });
    if (session.is_creating) bumpOwnerUsage(drive.owner_id as string, { files: 1 });
    deleteUploadSession(session.id);
    return NextResponse.json({ complete: true, receivedBytes: total, path: session.path });
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  } finally {
    unlockSession(session.id);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { driveId, uploadId } = await params;
  const g = await gateSession(driveId, uploadId);
  if ("error" in g) return g.error;
  // Same lock as PATCH: an abort racing a final part could delete the
  // fully-assembled temp between its last append and its rename — losing
  // every uploaded byte. 409 lets the caller retry after the part settles.
  if (!lockSession(g.session.id)) {
    return NextResponse.json({ error: "a part is in flight — retry" }, { status: 409 });
  }
  try {
    // Best-effort temp cleanup (an offline agent can't delete its own file);
    // the session row goes regardless — a missed temp is hidden junk under
    // .aindrive, swept by the next session create after the TTL.
    await callAgent(driveId, g.drive.drive_secret, { method: "delete", path: g.session.temp_path }).catch(() => {});
    deleteUploadSession(g.session.id);
    return NextResponse.json({ ok: true });
  } finally {
    unlockSession(g.session.id);
  }
}
