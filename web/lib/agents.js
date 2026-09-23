import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { db } from "./db.js";
import { verifyPayload, signPayload } from "./sig.js";
import { broadcastReload } from "./dochub.js";
import { trace, docIdFor } from "./trace.js";
import { log } from "./logger.js";

/**
 * In-memory registry of currently-connected agent WebSockets.
 *   driveId → { ws, driveSecret, pending: Map<reqId, { resolve, reject, timer }> }
 *
 * Pinned on globalThis so server.js (Node ESM import) and Next.js API routes
 * (Webpack-bundled import) share ONE Map even though they receive different
 * module instances of this file.
 */
const agents = globalThis.__aindrive_agent_map ?? new Map();
if (!globalThis.__aindrive_agent_map) globalThis.__aindrive_agent_map = agents;

const PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 25_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
// Live rotation: the agent's old secret still verifies responses for this long
// after a switch (mirrors cli/src/rotation.js GRACE_MS).
const ROTATION_GRACE_MS = 60_000;
const ROTATION_SWEEP_MS = 5 * 60_000;

export function isAgentConnected(driveId) {
  return agents.has(driveId);
}

export function listConnectedDrives() {
  return [...agents.keys()];
}

/**
 * Drop the live agent for a drive that is being deleted. The agent's token
 * row goes away with the drive, so its next reconnect is refused (4404); this
 * just stops it answering in the meantime.
 */
export function disconnectAgent(driveId) {
  const entry = agents.get(driveId);
  if (!entry) return false;
  try { entry.ws.close(4410, "drive deleted"); } catch {}
  agents.delete(driveId);
  return true;
}

/**
 * Send a single RPC call to the agent for `driveId` and await its response.
 * `params` is { method, ...args } per shared protocol.
 */
export async function sendRpc(driveId, params, opts = {}) {
  const entry = agents.get(driveId);
  if (!entry) {
    const e = new Error("agent offline");
    e.status = 504;
    throw e;
  }
  const reqId = randomReqId();
  const issuedAt = Date.now();
  const base = { v: PROTOCOL_VERSION, reqId, driveId, issuedAt, params };
  const sig = signPayload(entry.driveSecret, base);
  const frame = { type: "request", ...base, sig };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      entry.pending.delete(reqId);
      const e = new Error("agent timeout");
      e.status = 504;
      reject(e);
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    entry.pending.set(reqId, { resolve, reject, timer });
    try {
      log.debug({ driveId, method: params.method, reqId, readyState: entry.ws.readyState }, "[sendRpc]");
      try { trace("server", "rpc-out", { docId: docIdFor(driveId, params.path || ""), extra: { method: params.method, reqId } }); } catch {}
      entry.ws.send(JSON.stringify(frame));
      log.debug({ reqId }, "[sendRpc] sent");
    } catch (e) {
      clearTimeout(timer);
      entry.pending.delete(reqId);
      reject(e);
    }
  });
}

export async function onAgentConnect(ws, req, query) {
  const driveId = String(query?.driveId || "");
  const auth = req.headers["authorization"];
  if (!driveId || !auth || !auth.startsWith("Bearer ")) {
    ws.close(4401, "unauthorized");
    return;
  }
  const token = auth.slice(7);

  const row = db
    .prepare("SELECT agent_token_hash, drive_secret, rotation_pending FROM drives WHERE id = ?")
    .get(driveId);
  if (!row) {
    ws.close(4404, "no such drive");
    return;
  }
  const ok = await bcrypt.compare(token, row.agent_token_hash);
  if (!ok) {
    ws.close(4401, "bad token");
    return;
  }

  // Multi-device: track ALL connected agent sockets per driveId for sync broadcasts.
  // The "primary" agent (used for fs/* RPC) is still the latest connect, but sync frames
  // fan out to every connected device.
  if (!globalThis.__aindrive_agents_by_drive) globalThis.__aindrive_agents_by_drive = new Map();
  const peerSet = globalThis.__aindrive_agents_by_drive.get(driveId) ?? new Set();
  globalThis.__aindrive_agents_by_drive.set(driveId, peerSet);
  peerSet.add(ws);

  if (agents.has(driveId)) {
    // Note: do NOT force-close the previous primary — we keep multiple sockets for
    // multi-device. The most recent connection becomes the RPC target.
  }

  const entry = { ws, driveSecret: row.drive_secret, pending: new Map() };
  agents.set(driveId, entry);
  db.prepare("UPDATE drives SET last_seen_at = datetime('now') WHERE id = ?").run(driveId);

  log.info({ drive: driveId }, "agent connected");
  try { trace("server", "agent-connect", { docId: "agent-" + driveId }); } catch {}
  try { ws.send(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION })); } catch {}
  if (row.rotation_pending) {
    // Give the agent a moment to finish its own connect-time setup first.
    setTimeout(() => {
      rotateAgentLive(driveId)
        .then((r) => log.info({ drive: driveId, ...r }, "[rotation] on connect"))
        .catch((e) => log.warn({ drive: driveId, err: e.message }, "[rotation] on connect failed"));
    }, 2000).unref?.();
  }

  const heartbeat = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.ping(); } catch {}
    db.prepare("UPDATE drives SET last_seen_at = datetime('now') WHERE id = ?").run(driveId);
  }, HEARTBEAT_INTERVAL_MS);

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString("utf8")); }
    catch { return; }
    // Agent → server hello: record the device hostname so the UI can show it
    // next to the drive name (helpful when the user runs `aindrive` on multiple
    // machines under the same account).
    if (msg?.type === "agent-hello" && typeof msg.hostname === "string") {
      const h = msg.hostname.slice(0, 100);
      try { db.prepare("UPDATE drives SET last_hostname = ? WHERE id = ?").run(h, driveId); } catch {}
      return;
    }
    // Agent → server fs.watch notification: forward to live editors as 'reload'.
    if (msg?.type === "fs-changed" && typeof msg.path === "string") {
      const sent = broadcastReload(driveId, msg.path);
      if (sent > 0) log.info({ drive: driveId, path: msg.path, editors: sent }, "[fs-changed] editors reloaded");
      return;
    }
    // Multi-device sync frames — broadcast to OTHER connected agents on the same drive.
    if (msg?.type && msg.type.startsWith("sync-")) {
      const peers = (globalThis.__aindrive_agents_by_drive ?? new Map()).get(driveId);
      if (peers) {
        for (const otherWs of peers) {
          if (otherWs === ws || otherWs.readyState !== otherWs.OPEN) continue;
          try { otherWs.send(JSON.stringify(msg)); } catch {}
        }
      }
      return;
    }
    if (!msg || msg.type !== "response" || !msg.reqId) return;
    const { sig, type, ...rest } = msg;
    const sigOk = verifyPayload(entry.driveSecret, rest, sig)
      || (entry.prevSecret && Date.now() < entry.prevUntil && verifyPayload(entry.prevSecret, rest, sig));
    if (!sigOk) {
      log.warn({ reqId: msg.reqId }, "[agents] dropped response with bad sig");
      return;
    }
    const pending = entry.pending.get(msg.reqId);
    if (!pending) return;
    entry.pending.delete(msg.reqId);
    clearTimeout(pending.timer);
    try { trace("server", "rpc-in-resp", { docId: "agent-" + driveId, byteLen: data.length, extra: { reqId: msg.reqId, ok: msg.ok } }); } catch {}
    if (msg.ok) pending.resolve(msg.result);
    else {
      const e = new Error(msg.error || "agent error");
      e.status = 502;
      pending.reject(e);
    }
  });

  ws.on("close", () => {
    clearInterval(heartbeat);
    if (agents.get(driveId) === entry) agents.delete(driveId);
    const peers = globalThis.__aindrive_agents_by_drive?.get(driveId);
    if (peers) {
      peers.delete(ws);
      if (peers.size === 0) globalThis.__aindrive_agents_by_drive.delete(driveId);
    }
    for (const { reject, timer } of entry.pending.values()) {
      clearTimeout(timer);
      const e = new Error("agent disconnected");
      e.status = 504;
      reject(e);
    }
    entry.pending.clear();
    log.info({ drive: driveId }, "agent disconnected");
    try { trace("server", "agent-disconnect", { docId: "agent-" + driveId }); } catch {}
  });

  ws.on("error", (e) => {
    log.warn({ drive: driveId, err: e?.message || String(e) }, "agent ws error");
  });
}

function randomReqId() {
  return Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
}

/**
 * Rotate a drive's agent token + drive secret WITHOUT disconnecting it.
 *
 * Sends `rotate-credentials` (signed with the current secret) to the live
 * agent, which persists the new pair and answers ok (cli/src/rotation.js).
 * Only then is the pair stored here, and the old secret keeps verifying
 * responses for ROTATION_GRACE_MS. If the ok never arrives, nothing changes
 * server-side and the agent falls back to its previous pair on its next
 * refused handshake.
 *
 * Refuses when the drive has several connected devices: the others would
 * keep the old token and be locked out on reconnect. Agents that predate this
 * (older CLI, mobile) answer "unknown method" → `unsupported`, and the drive
 * stays `rotation_pending` until it upgrades or the owner rotates by hand.
 *
 * @returns {Promise<{status: "rotated"|"offline"|"multi-device"|"unsupported"|"busy"|"failed", error?: string}>}
 */
export async function rotateAgentLive(driveId) {
  const entry = agents.get(driveId);
  if (!entry) return { status: "offline" };
  const peers = globalThis.__aindrive_agents_by_drive?.get(driveId);
  if (peers && peers.size > 1) return { status: "multi-device" };
  if (entry.rotating) return { status: "busy" };
  entry.rotating = true;
  try {
    const agentToken = nanoid(48);
    const driveSecret = nanoid(48);
    // Hash BEFORE asking the agent, so the window between its ok and our
    // write is a single synchronous UPDATE.
    const hash = await bcrypt.hash(agentToken, 10);
    let result;
    try {
      result = await sendRpc(driveId, { method: "rotate-credentials", agentToken, driveSecret }, { timeoutMs: 15_000 });
    } catch (e) {
      if (/unknown method/i.test(e.message)) return { status: "unsupported" };
      return { status: "failed", error: e.message };
    }
    if (!result?.ok) return { status: "failed", error: "agent did not confirm" };
    db.prepare("UPDATE drives SET agent_token_hash = ?, drive_secret = ?, rotation_pending = 0 WHERE id = ?")
      .run(hash, driveSecret, driveId);
    entry.prevSecret = entry.driveSecret;
    entry.prevUntil = Date.now() + ROTATION_GRACE_MS;
    entry.driveSecret = driveSecret;
    return { status: "rotated" };
  } finally {
    entry.rotating = false;
  }
}

/**
 * Periodically rotate pending drives whose agent is online. Offline ones are
 * handled by onAgentConnect when they come back. Called once from server.js.
 */
export function startRotationSweeper() {
  if (globalThis.__aindrive_rotation_sweeper) return;
  const sweep = async () => {
    let pending;
    try { pending = db.prepare("SELECT id FROM drives WHERE rotation_pending = 1").all(); }
    catch { return; }
    for (const { id } of pending) {
      if (!agents.has(id)) continue;
      try {
        const r = await rotateAgentLive(id);
        log.info({ drive: id, ...r }, "[rotation] sweep");
      } catch (e) { log.warn({ drive: id, err: e.message }, "[rotation] sweep failed"); }
    }
  };
  globalThis.__aindrive_rotation_sweeper = setInterval(sweep, ROTATION_SWEEP_MS);
  globalThis.__aindrive_rotation_sweeper.unref?.();
}
