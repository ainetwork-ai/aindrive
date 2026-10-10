import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { db } from "./db.js";
import { verifyPayload, signPayload } from "./sig.js";
import { broadcastReload } from "./dochub.js";
import { trace, docIdFor } from "./trace.js";
import { log } from "./logger.js";
import { onAgentOnlineChanged, onFsChanged } from "./share-events-core.js";
import { dropGenerations, observeEntry } from "./path-generations.js";
import { normalizePath } from "./path.js";

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
// Git over SSH stream frames (lib/protocol.ts GitStreamFrame): sender stops at
// this many unacknowledged bytes per direction; mirrors cli/src/git-exec.js.
const GIT_SSH_WINDOW_BYTES = 4 * 1024 * 1024;
const GIT_SSH_CHUNK_BYTES = 256 * 1024;

/**
 * HTTP status for an error the device agent answered with. The agent relays
 * its own message (errno text from the device's filesystem, or its path
 * guard's words); most are the device failing (502), but some are the
 * request's fault or a plain answer, and a 502 for those tells a client to
 * retry what can never work (plan 12.3: a 256-byte name answered 502).
 */
export function agentErrorStatus(message) {
  const m = String(message || "");
  if (/\bENOENT\b|no such file or directory/i.test(m)) return 404;
  if (/\bENAMETOOLONG\b|name too long|path too long/i.test(m)) return 400;
  if (/^invalid path|path escapes drive root|reserved path|cannot (?:rename|delete) root/i.test(m)) return 400;
  if (/\bEISDIR\b|is a directory|\bENOTDIR\b|not a directory/i.test(m)) return 400;
  if (/\bENOSPC\b|no space left|\bEDQUOT\b|quota exceeded/i.test(m)) return 507;
  return 502;
}

export function isAgentConnected(driveId) {
  return agents.has(driveId);
}

export function listConnectedDrives() {
  return [...agents.keys()];
}

/**
 * Drop every live device socket of a drive — the RPC primary AND the other
 * devices kept for sync — once its credentials stop being valid:
 *   - drive deleted (4410): the token row goes with the drive, so a reconnect
 *     is refused (4404);
 *   - credentials rotated from the web (4401): a lost or removed device would
 *     otherwise keep answering on its open socket — the server signs requests
 *     with the secret it held when that socket connected — until it happened
 *     to reconnect. Its reconnect with the old token is refused (4401).
 * Returns how many sockets were closed.
 */
export function disconnectAgent(driveId, code = 4410, reason = "drive deleted") {
  const sockets = new Set(globalThis.__aindrive_agents_by_drive?.get(driveId) ?? []);
  const entry = agents.get(driveId);
  if (entry) {
    sockets.add(entry.ws);
    // Off the RPC map now, not when the close handshake ends: no request may
    // reach the removed device in between (its "close" then records nothing).
    agents.delete(driveId);
    // A rotated drive still exists, so its audience hears it went offline.
    if (code !== 4410) {
      try { onAgentOnlineChanged(driveId, false); }
      catch (e) { log.warn({ drive: driveId, err: e?.message || String(e) }, "[share-events] availability(offline) failed"); }
    }
  }
  for (const ws of sockets) { try { ws.close(code, reason); } catch {} }
  return sockets.size;
}

/**
 * Ping `ws` every `intervalMs`; terminate it if nothing came back since the
 * previous ping — no pong and no bytes of any frame.
 * A socket whose agent vanished (laptop asleep, network gone) never closes on
 * its own, so without this the drive stays "connected" and every request waits
 * out the RPC timeout. terminate() fires "close", which drops the agent entry.
 * Returns the interval handle (clear it on close).
 */
export function startHeartbeat(ws, { intervalMs = HEARTBEAT_INTERVAL_MS, onBeat = () => {}, onDead = () => {} } = {}) {
  let answered = true;
  const alive = () => { answered = true; };
  ws.on("pong", alive);
  // Bytes still arriving count as an answer. A pong queues behind the frame the
  // agent is sending, and a phone uploading a multi-MB download chunk over a
  // slow link takes longer than a beat — dropping it then killed every download.
  ws._socket?.on("data", alive);
  return setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    if (!answered) { onDead(); ws.terminate(); return; }
    answered = false;
    try { ws.ping(); } catch {}
    onBeat();
  }, intervalMs);
}

/**
 * An agent reports names as its filesystem spells them — NFD for files made by
 * macOS tools. The server's path identity is NFC (lib/path.js normalizePath),
 * and every name here is later compared with stored shares, grants and doc
 * keys, so names enter the server in that one spelling. Agents resolve either
 * spelling back to the file (cli/src/rpc.js safeResolve).
 */
export function canonicalAgentResult(result) {
  const nfc = (e) => (e ? { ...e, name: String(e.name).normalize("NFC"), path: String(e.path).normalize("NFC") } : e);
  if (result?.method === "list" && Array.isArray(result.entries)) return { ...result, entries: result.entries.map(nfc) };
  if (result?.method === "stat") return { ...result, entry: nfc(result.entry) };
  return result;
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

  // Change feed: `file.availability` only when the drive's online answer
  // (isAgentConnected) actually flips — a second device joining an online
  // drive, or a re-connect that replaces the primary, records nothing.
  const wasOnline = agents.has(driveId);
  const entry = { ws, driveSecret: row.drive_secret, pending: new Map(), gitExecs: new Map() };
  agents.set(driveId, entry);
  db.prepare("UPDATE drives SET last_seen_at = datetime('now') WHERE id = ?").run(driveId);
  if (!wasOnline) {
    try { onAgentOnlineChanged(driveId, true); }
    catch (e) { log.warn({ drive: driveId, err: e?.message || String(e) }, "[share-events] availability(online) failed"); }
  }

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

  const heartbeat = startHeartbeat(ws, {
    onBeat: () => db.prepare("UPDATE drives SET last_seen_at = datetime('now') WHERE id = ?").run(driveId),
    onDead: () => log.warn({ drive: driveId }, "agent missed a heartbeat — dropping its socket"),
  });

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
      // Change feed: the frame names the path only (cli/src/agent.js sends
      // {type, path}; fs.watch's rename/change kind is not carried), so stat it
      // to tell a removal from a write. A rename thus lands as file.deleted
      // (old path) + file.updated (new path) — Phase A of the plan's task 10.
      // The RPC is best-effort: with no answer the change is still recorded as
      // file.updated without a revision. Never lets an error reach the socket.
      recordFsChange(driveId, msg.path).catch((e) =>
        log.warn({ drive: driveId, path: msg.path, err: e?.message || String(e) }, "[share-events] fs-changed failed"));
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
    // Git over SSH stream frames (openGitExec): signed like a response, routed
    // to the live exec by id; unknown ids (a finished exec) are dropped.
    if (msg?.type === "git-stdout" || msg?.type === "git-stderr" || msg?.type === "git-exit" || msg?.type === "git-stdin-ack") {
      if (typeof msg.execId !== "string") return;
      const { sig, type, ...rest } = msg;
      const ok = typeof sig === "string" && (verifyPayload(entry.driveSecret, rest, sig)
        || (entry.prevSecret && Date.now() < entry.prevUntil && verifyPayload(entry.prevSecret, rest, sig)));
      if (!ok) { log.warn({ drive: driveId, execId: msg.execId, type }, "[agents] dropped git stream frame with bad sig"); return; }
      entry.gitExecs.get(msg.execId)?.onFrame(msg);
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
    if (msg.ok) pending.resolve(canonicalAgentResult(msg.result));
    else {
      const e = new Error(msg.error || "agent error");
      e.status = agentErrorStatus(e.message);
      pending.reject(e);
    }
  });

  ws.on("close", () => {
    clearInterval(heartbeat);
    if (agents.get(driveId) === entry) {
      agents.delete(driveId);
      // The drive's online answer just flipped (see onAgentOnlineChanged above).
      try { onAgentOnlineChanged(driveId, false); }
      catch (e) { log.warn({ drive: driveId, err: e?.message || String(e) }, "[share-events] availability(offline) failed"); }
    }
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
    for (const ex of [...entry.gitExecs.values()]) ex.onFrame({ type: "git-exit", execId: ex.execId, code: null, signal: null, error: "agent disconnected" });
    entry.gitExecs.clear();
    log.info({ drive: driveId }, "agent disconnected");
    try { trace("server", "agent-disconnect", { docId: "agent-" + driveId }); } catch {}
  });

  ws.on("error", (e) => {
    log.warn({ drive: driveId, err: e?.message || String(e) }, "agent ws error");
  });
}

/**
 * Record an `fs-changed` frame in the change feed: stat the path on the device
 * (`exists` false → file.deleted, true → file.updated + revision, unknown →
 * file.updated) and fan out to the drive's audience. See onFsChanged.
 */
async function recordFsChange(driveId, path) {
  let info = {};
  try {
    const r = await sendRpc(driveId, { method: "stat", path: String(path).normalize("NFC") }, { timeoutMs: 10_000 });
    info = r && "entry" in r ? { exists: !!r.entry, entry: r.entry ?? undefined } : {};
  } catch (e) {
    log.debug({ drive: driveId, path, err: e?.message || String(e) }, "[share-events] stat before fs-changed record failed");
  }
  // Per-path generations (task 10.2): a path the device says is gone loses its
  // generation, so whatever is created there next gets a new one; a re-created
  // file (another birth time) rotates it. Best-effort, like the feed itself.
  try {
    const p = normalizePath(String(path));
    if (info.exists === false) dropGenerations(driveId, p);
    else if (info.entry) observeEntry(driveId, p, info.entry);
  } catch (e) {
    log.debug({ drive: driveId, err: e?.message || String(e) }, "[path-generations] fs-changed not applied");
  }
  return onFsChanged(driveId, path, info);
}

/**
 * Git over SSH (lib/git-ssh/relay.ts): run `git <service> <repo>` on the drive's
 * agent as a live bidirectional pipe. Sends the `git-ssh-exec` RPC (the agent
 * spawns git and answers once its stdin is open), then relays bytes as signed
 * stream frames on the same socket (lib/protocol.ts GitStreamFrame):
 *   handle.write(buf) / handle.end()  → git's stdin      (git-stdin frames)
 *   onStdout(buf) / onStderr(buf)     ← git's stdout/err (git-stdout / git-stderr)
 *   onExit({code, signal, error})     ← git finished, or the agent went away
 * Flow control: the agent stops sending stdout at GIT_SSH_WINDOW_BYTES
 * unacknowledged; call handle.ack(n) as the SSH channel consumes bytes.
 * Symmetrically `handle.inFlight()` is how many stdin bytes the agent has not
 * yet written to git — the caller pauses its source above the window.
 * The RPC error (not a repo, cap hit, agent offline) rejects the promise and
 * registers nothing. `kill()` asks the agent to SIGKILL git (timeout, client gone).
 */
export async function openGitExec(driveId, { repo, service, protocol }, { onStdout, onStderr, onExit }) {
  const entry = agents.get(driveId);
  if (!entry) { const e = new Error("agent offline"); e.status = 504; throw e; }
  const execId = randomReqId() + randomReqId();
  let seq = 0;
  let inFlight = 0;
  let finished = false;
  const ex = {
    execId,
    onFrame(msg) {
      if (finished) return;
      if (msg.type === "git-stdout") {
        try { onStdout(Buffer.from(String(msg.data || ""), "base64")); } catch (e) { log.warn({ driveId, execId, err: e?.message }, "[git-ssh] onStdout threw"); }
      } else if (msg.type === "git-stderr") {
        try { onStderr(Buffer.from(String(msg.data || ""), "base64")); } catch {}
      } else if (msg.type === "git-stdin-ack") {
        inFlight = Math.max(0, inFlight - (Number(msg.ack) || 0));
        handle.onDrain?.();
      } else if (msg.type === "git-exit") {
        finished = true;
        entry.gitExecs.delete(execId);
        try { onExit({ code: typeof msg.code === "number" ? msg.code : null, signal: msg.signal ?? null, error: msg.error }); } catch {}
      }
    },
  };
  const sendStdin = (fields) => {
    if (finished || entry.ws.readyState !== entry.ws.OPEN) return;
    const base = { v: PROTOCOL_VERSION, driveId, execId, seq: seq++, ...fields };
    const sig = signPayload(entry.driveSecret, base);
    try { entry.ws.send(JSON.stringify({ type: "git-stdin", ...base, sig })); } catch (e) { log.warn({ driveId, execId, err: e?.message }, "[git-ssh] stdin send failed"); }
  };
  const handle = {
    execId,
    onDrain: null,
    windowBytes: GIT_SSH_WINDOW_BYTES,
    write(buf) {
      for (let off = 0; off < buf.length; off += GIT_SSH_CHUNK_BYTES) {
        const part = buf.subarray(off, Math.min(buf.length, off + GIT_SSH_CHUNK_BYTES));
        inFlight += part.length;
        sendStdin({ data: Buffer.from(part).toString("base64") });
      }
      return inFlight < GIT_SSH_WINDOW_BYTES;
    },
    inFlight: () => inFlight,
    ack(n) { if (n > 0) sendStdin({ ack: n }); },
    end() { sendStdin({ eof: true }); },
    kill() { sendStdin({ kill: true }); },
    get finished() { return finished; },
  };
  // Register BEFORE the RPC answers: git may write (advertise refs) at once.
  entry.gitExecs.set(execId, ex);
  try {
    await sendRpc(driveId, { method: "git-ssh-exec", repo, service, execId, ...(protocol ? { protocol } : {}) }, { timeoutMs: 15_000 });
  } catch (e) {
    finished = true;
    entry.gitExecs.delete(execId);
    throw e;
  }
  return handle;
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
