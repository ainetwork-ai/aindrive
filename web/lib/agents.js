import bcrypt from "bcryptjs";
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

export function isAgentConnected(driveId) {
  return agents.has(driveId);
}

export function listConnectedDrives() {
  return [...agents.keys()];
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
    .prepare("SELECT agent_token_hash, drive_secret FROM drives WHERE id = ?")
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

  const heartbeat = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.ping(); } catch {}
    db.prepare("UPDATE drives SET last_seen_at = datetime('now') WHERE id = ?").run(driveId);
  }, HEARTBEAT_INTERVAL_MS);

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString("utf8")); }
    catch { return; }
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
    if (!verifyPayload(entry.driveSecret, rest, sig)) {
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
