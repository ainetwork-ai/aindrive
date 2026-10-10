import WebSocket from "ws";
import { watch } from "node:fs";
import { createRequire } from "node:module";
import { hostname as osHostname } from "node:os";
import { join, sep } from "node:path";
import { handleRpc, cliTrace, docIdFor, setTraceServer, isSelfWrite, rpcMethodNames } from "./rpc.js";
import { signPayload, verifyPayload } from "./sig.js";
import { attachSync } from "./willow-sync.js";
import { log } from "./logger.js";
import { applyRotation, revertRotation, commitRotation, adoptConfigOnDisk, GRACE_MS } from "./rotation.js";
import { afanBridgeEnabled, createAfanBridge } from "./afan-bridge.js";
import { readGlobalCreds } from "./config.js";

const PROTOCOL_VERSION = 1;
const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require("../package.json");
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000];
// The server accepted the socket and then refused this device (web/lib/agents.js):
// its key was rotated from the web (4401) or the drive was deleted (4410, then
// 4404). Retrying every second only burns a bcrypt compare per try on the
// server; wait long, in case the owner re-attaches the folder.
const REFUSED_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000];
const REFUSAL_CODES = new Map([
  [4401, "this device's key is no longer valid (rotated or removed from the web)"],
  [4404, "the drive no longer exists"],
  [4410, "the drive was deleted"],
]);

/** Why the server refused this device, from a close code — or null for an ordinary disconnect. */
export function refusalOf(code) {
  return REFUSAL_CODES.get(code) ?? null;
}

/** Wait before the next connect: the refused schedule after a refusal, the normal one otherwise. */
export function reconnectWait(attempt, refused) {
  const table = refused ? REFUSED_BACKOFF_MS : RECONNECT_BACKOFF_MS;
  return table[Math.min(attempt, table.length - 1)];
}
const FS_DEBOUNCE_MS = 500;
const DRAIN_TIMEOUT_MS = 10_000;
const DRAIN_POLL_MS = 50;        // poll cadence while waiting for in-flight RPCs to drain
const CLOSE_HANDSHAKE_MS = 200;  // grace for the WS close handshake to flush before exit
// The server pings every 20s (web/lib/agents.js). Silence past 3.5 pings means
// the connection went half-open — no "close" will ever come — so drop it.
const SERVER_SILENCE_LIMIT_MS = 70_000;
const SILENCE_CHECK_MS = 10_000;

// Graceful shutdown state — module-level so signal handlers can reach it.
let shuttingDown = false;
let inFlightCount = 0;
let activeWs = null; // set by connectOnce while open
// Old secret still accepted for a short window after a live rotation, so
// requests the server signed just before switching don't get dropped.
let graceSecret = null;
let graceUntil = 0;

function installShutdownHandlers() {
  let shutdownStarted = false;

  const doShutdown = async (signal) => {
    if (shuttingDown && shutdownStarted) {
      // Second signal during drain → force exit immediately
      log.warn({ signal }, "second signal received during shutdown — forcing exit");
      process.exit(1);
    }
    shuttingDown = true;
    shutdownStarted = true;
    log.info({ signal, inFlightCount }, "agent shutting down");

    // Wait up to DRAIN_TIMEOUT_MS for in-flight RPCs to complete
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (inFlightCount > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
    }
    if (inFlightCount > 0) {
      log.warn({ inFlightCount }, "drain timeout — forcing close with pending RPCs");
    }

    // Close the WebSocket cleanly
    if (activeWs && activeWs.readyState === WebSocket.OPEN) {
      try { activeWs.close(1001, "agent shutting down"); } catch {}
      // Give the close handshake a moment
      await new Promise((r) => setTimeout(r, CLOSE_HANDSHAKE_MS));
    }

    // Flush pino logger if it exposes a flush method
    if (typeof log.flush === "function") {
      try { await new Promise((r) => { log.flush(r); }); } catch {}
    }

    process.exit(0);
  };

  process.on("SIGTERM", () => doShutdown("SIGTERM"));
  process.on("SIGINT",  () => doShutdown("SIGINT"));
}

export async function runAgent({ root, drive, server }) {
  setTraceServer(server); // direct trace POSTs to the right server
  const wsUrl = toWsUrl(server, drive.driveId);
  let attempt = 0;

  installShutdownHandlers();

  const afanBridge = startAfanBridge({ root, drive, server });

  let refusedAttempt = 0;
  while (!shuttingDown) {
    let outcome = null;
    try {
      outcome = await connectOnce({ root, drive, wsUrl, afanBridge });
      attempt = 0;
    } catch (e) {
      log.error({ err: e.message || String(e) }, "agent connection error");
    }
    if (shuttingDown) break;
    if (outcome?.retryNow) continue; // new credentials on disk (`aindrive rotate-token`)
    let wait;
    if (outcome?.refused) {
      // One stable message (the Mac app shows it as the folder's error, desktop/src/agents.js parseLine).
      wait = reconnectWait(refusedAttempt++, true);
      log.warn({ code: outcome.code, reason: outcome.refused, waitSec: wait / 1000,
        hint: "the drive stays offline; its owner can re-attach this folder with `aindrive rotate-token`" }, "device refused");
    } else {
      refusedAttempt = 0;
      wait = reconnectWait(attempt, false);
      attempt++;
      log.info({ waitSec: wait / 1000 }, "reconnecting");
    }
    if (outcome?.refused) {
      // Refused: wait long, but reconnect as soon as the folder gets a new key
      // (`aindrive rotate-token` here — it may finish just after the server
      // already dropped us for the rotation it made).
      if (await waitForNewKey({ root, drive, ms: wait })) log.info("new credentials in the folder's config — reconnecting with them");
    } else {
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

const KEY_POLL_MS = 2000;

/** Sleep up to `ms`, checking the folder's config for a new pair; true when one was adopted. */
export async function waitForNewKey({ root, drive, ms, pollMs = KEY_POLL_MS, adopt = adoptConfigOnDisk }) {
  const end = Date.now() + ms;
  while (!shuttingDown && Date.now() < end) {
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, end - Date.now()))));
    try { if (await adopt({ root, drive })) return true; }
    catch (e) { log.warn({ err: e.message }, "re-reading the drive config failed"); }
  }
  return false;
}

/**
 * Terminate `ws` once the server has been silent (no ping, no bytes) for
 * `limitMs`. A half-open connection — network blip, laptop sleep, a proxy
 * dropping it without a close — never fires "close", so without this the
 * reconnect loop never runs and the drive stays offline. terminate() fires
 * "close", which runAgent turns into a reconnect.
 */
export function watchServerSilence(ws, { limitMs = SERVER_SILENCE_LIMIT_MS, checkMs = SILENCE_CHECK_MS } = {}) {
  let lastHeard = Date.now();
  const heard = () => { lastHeard = Date.now(); };
  ws.on("ping", heard);
  ws.on("message", heard);
  // Bytes still arriving count too: a big frame over a slow link delays the
  // ping queued behind it (mirrors the server's startHeartbeat).
  ws._socket?.on("data", heard);
  const timer = setInterval(() => {
    if (Date.now() - lastHeard < limitMs) return;
    log.warn({ silentSec: Math.round((Date.now() - lastHeard) / 1000) }, "server went silent — dropping the connection to reconnect");
    clearInterval(timer);
    ws.terminate();
  }, checkMs);
  ws.once("close", () => clearInterval(timer));
}

/**
 * The first frame on the socket (phone protocol v2, docs/AINUI.md §6): the
 * hostname as before, plus platform, appVersion, every RPC method this agent
 * answers and its optional capabilities. `caps` is empty: the desktop agent's
 * LLM `agent-ask` has no read-only mode yet, so it does not claim "ask.v2" and
 * the server's `ask` skill refuses questions to it up front.
 */
export function agentHello({ hostname = osHostname() } = {}) {
  return {
    type: "agent-hello",
    hostname,
    platform: "cli",
    appVersion: APP_VERSION,
    // rotate-credentials is answered here in agent.js, the rest by handleRpc.
    methods: [...rpcMethodNames(), "rotate-credentials"].sort(),
    caps: [],
  };
}

// Exported for characterization tests (pure helper, no IO). Used by runAgent.
export function toWsUrl(server, driveId) {
  const u = new URL(`/api/agent/connect?driveId=${encodeURIComponent(driveId)}`, server);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

/**
 * The afan host bridge (afan-bridge.js) for this folder, or null. Opt-in: `"afanBridge": true` in the
 * folder's .aindrive/config.json, or AINDRIVE_AFAN_BRIDGE=1. It verifies authors with this machine's
 * `aindrive login` session — only when that session is for this drive's server.
 */
export function startAfanBridge({ root, drive, server }, env = process.env) {
  if (!afanBridgeEnabled(drive, env)) return null;
  const serverUrl = drive.serverUrl || server;
  const sameServer = (a, b) => { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } };
  const bridge = createAfanBridge({
    root,
    driveId: drive.driveId,
    server: serverUrl,
    getSession: async () => {
      const creds = await readGlobalCreds();
      return creds?.sessionCookie && sameServer(creds.server, serverUrl) ? creds.sessionCookie : null;
    },
    ainizeUrl: env.AINIZE_URL,
    ainizeToken: env.AINIZE_TOKEN,
    hostVersion: APP_VERSION,
  });
  bridge.startCatalogTimer();
  log.info({ driveId: drive.driveId }, "afan bridge on");
  return bridge;
}

function connectOnce({ root, drive, wsUrl, afanBridge = null }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: { authorization: `Bearer ${drive.agentToken}` },
      handshakeTimeout: 10_000,
      // Match the server's WS frame cap (server.js). A base64 upload (×1.33)
      // rides one RPC message; the 100 MB default drops the connection on
      // ~75 MB+ files. 160 MB keeps the 100 MB fs-write cap within one frame.
      maxPayload: 160 * 1024 * 1024,
    });

    let opened = false;

    let watcher = null;
    const recentChanges = new Map(); // path → debounce timer

    ws.once("open", () => {
      opened = true;
      activeWs = ws;
      watchServerSilence(ws);
      log.info({ driveId: drive.driveId }, "connected");
      // Requests written while this agent was offline — the watcher only sees new ones.
      if (afanBridge) afanBridge.scan().catch((e) => log.warn({ err: e.message }, "afan bridge scan failed"));
      // Tell the server which machine this agent is running on (shown next to
      // the drive in the UI) and what it can do (phone protocol v2).
      try { ws.send(JSON.stringify(agentHello())); } catch {}
      // Multi-device sync: gossip yjs_entries with peers via the same WS
      try { attachSync(ws, drive, root); } catch (e) { log.warn({ err: e.message }, "attachSync failed"); }
      // Start fs watcher — sends {type:'fs-changed', path} frames so the server can
      // broadcast 'reload' to any open editors of that path.
      try {
        watcher = watch(root, { recursive: true }, (event, filename) => {
          if (!filename) return;
          const rel = filename.split(sep).join("/");
          if (rel.startsWith(".aindrive/") || rel === ".aindrive") return;
          // A git push into a bare repo in the drive churns transient quarantine
          // and lock files (objects/incoming-*/…, *.lock, tmp_*) that appear and
          // vanish faster than we can act on them. Broadcasting them is pointless
          // and the vanished paths are exactly what races the recursive watcher
          // below, so skip them. The durable result (objects/pack/*, refs/*) is
          // not matched here and still syncs.
          if (/(^|\/)objects\/(incoming-|tmp_)/.test(rel) || /(^|\/)tmp_/.test(rel) || rel.endsWith(".lock")) return;
          // afan requests (people/*/agent-requests/*.md) go to the bridge too; it ignores everything else.
          if (afanBridge) afanBridge.notify(rel);
          const existing = recentChanges.get(rel);
          if (existing) clearTimeout(existing);
          const t = setTimeout(() => {
            recentChanges.delete(rel);
            // Skip if this change was caused by our own write RPC
            if (isSelfWrite(rel)) {
              try { cliTrace(root, docIdFor(root, rel), "fs-changed-suppressed", { extra: { path: rel } }); } catch {}
              return;
            }
            try { cliTrace(root, docIdFor(root, rel), "fs-changed", { extra: { path: rel } }); } catch {}
            try { ws.send(JSON.stringify({ type: "fs-changed", path: rel })); }
            catch (e) { log.warn({ err: e.message }, "fs-changed send failed"); }
          }, FS_DEBOUNCE_MS);
          recentChanges.set(rel, t);
        });
        // A recursive fs.watch on Linux scandirs subtrees as they change; when git
        // removes a quarantine dir (objects/incoming-*) mid-push the scandir fails
        // and the FSWatcher emits 'error'. Without this listener that error is
        // unhandled and takes the whole agent down (the drive goes offline). Log
        // and keep watching instead.
        watcher.on("error", (e) => log.warn({ err: e?.message || String(e) }, "fs.watch error (ignored)"));
      } catch (e) { log.warn({ err: e.message }, "fs.watch unavailable"); }
    });

    ws.on("message", async (data) => {
      log.debug({ raw: data.toString("utf8").slice(0, 200) }, "[agent recv]");
      let frame;
      try { frame = JSON.parse(data.toString("utf8")); }
      catch (e) { log.debug({ err: e.message }, "[agent recv] parse fail"); return; }
      if (frame?.type === "hello") {
        log.debug("[agent recv] hello");
        // The server only says hello after accepting our token → any fallback
        // pair kept from a previous rotation can go.
        commitRotation({ root, drive }).catch((e) => log.warn({ err: e.message }, "commitRotation failed"));
        return;
      }
      if (frame?.type !== "request" || !frame.reqId) { log.debug({ type: frame?.type }, "[agent recv] ignored"); return; }
      if (frame.v !== PROTOCOL_VERSION) { log.debug({ v: frame.v }, "[agent] bad version"); return; }
      const { sig, type, ...rest } = frame;
      log.debug({ sig: sig?.slice(0,8), keys: Object.keys(rest).sort().join(",") }, "[agent] verifying");
      const verified = verifyPayload(drive.driveSecret, rest, sig)
        || (graceSecret !== null && Date.now() < graceUntil && verifyPayload(graceSecret, rest, sig));
      log.debug({ verified }, "[agent] verified");
      if (!verified) {
        log.warn("dropped forged request");
        return;
      }

      // Reject new RPCs once shutdown is in progress
      if (shuttingDown) {
        log.debug({ method: frame.params?.method }, "[agent] rejecting RPC — shutting down");
        let response = { type: "response", reqId: frame.reqId, ok: false, error: "agent shutting down" };
        try {
          const { type: _t, ...payloadForSig } = response;
          response.sig = signPayload(drive.driveSecret, payloadForSig);
          ws.send(JSON.stringify(response));
        } catch {}
        return;
      }

      // Live credential rotation (see rotation.js): persist, answer with the
      // OLD secret, then switch. Handled here, not in handleRpc, because it
      // needs the drive config and the connection's signing state.
      if (frame.params?.method === "rotate-credentials") {
        let response;
        let rotation = null;
        try {
          rotation = await applyRotation({ root, drive, params: frame.params });
          response = { type: "response", reqId: frame.reqId, ok: true, result: { ok: true } };
        } catch (e) {
          response = { type: "response", reqId: frame.reqId, ok: false, error: sanitize(e.message) };
        }
        try {
          const { type: _t, ...payloadForSig } = response;
          response.sig = signPayload(drive.driveSecret, payloadForSig);
          ws.send(JSON.stringify(response));
        } catch (e) { log.error({ err: e.message }, "send/sign failed"); }
        if (rotation) {
          graceSecret = rotation.previousSecret;
          graceUntil = Date.now() + GRACE_MS;
          rotation.adopt();
          log.info({ driveId: drive.driveId }, "agent credentials rotated");
        }
        return;
      }

      log.debug({ method: frame.params?.method }, "[agent] handling");
      inFlightCount++;
      let response;
      try {
        const result = await handleRpc(frame.params, root);
        log.debug({ entries: result?.entries?.length }, "[agent] handleRpc ok");
        response = { type: "response", reqId: frame.reqId, ok: true, result };
      } catch (e) {
        log.error({ err: e.message }, "[agent] handleRpc threw");
        response = { type: "response", reqId: frame.reqId, ok: false, error: sanitize(e.message) };
      } finally {
        inFlightCount--;
      }
      try {
        const { type: _t, ...payloadForSig } = response;
        response.sig = signPayload(drive.driveSecret, payloadForSig);
        log.debug({ sig: response.sig.slice(0,8) }, "[agent] sending response");
        ws.send(JSON.stringify(response));
        log.debug("[agent] response sent");
      } catch (e) { log.error({ err: e.message }, "send/sign failed"); }
    });

    ws.once("close", async (code, reason) => {
      const msg = `disconnected${code ? ` (${code}${reason ? `: ${reason.toString()}` : ""})` : ""}`;
      // Token refused right after a live rotation → the server never stored
      // the new pair (its ok was lost). Fall back to the pair it still has.
      let outcome = null;
      if (code === 4401 && drive.previousCredentials) {
        try {
          if (await revertRotation({ root, drive })) { log.warn("token refused after rotation — reverted to previous credentials"); outcome = { retryNow: true }; }
        } catch (e) { log.error({ err: e.message }, "revertRotation failed"); }
      }
      // A key rotated on this machine (`aindrive rotate-token` while serving):
      // the folder's config already has the new pair — take it and reconnect.
      if (!outcome && code === 4401) {
        try { if (await adoptConfigOnDisk({ root, drive })) { log.info("new credentials in the folder's config — reconnecting with them"); outcome = { retryNow: true }; } }
        catch (e) { log.warn({ err: e.message }, "re-reading the drive config failed"); }
      }
      if (!outcome && refusalOf(code)) outcome = { refused: refusalOf(code), code };
      if (activeWs === ws) activeWs = null;
      if (watcher) { try { watcher.close(); } catch {} }
      for (const t of recentChanges.values()) clearTimeout(t);
      recentChanges.clear();
      if (opened) { log.info({ msg }, "disconnected"); resolve(outcome); }
      else reject(new Error(msg));
    });

    ws.once("error", (e) => {
      if (!opened) reject(new Error(`connect failed: ${e.message}`));
    });
  });
}

// Exported for characterization tests (pure helper, no IO). Used in the RPC
// error path to redact absolute paths from messages before they leave the agent.
export function sanitize(msg) {
  return String(msg || "error").replace(/\/[A-Za-z0-9_./-]+/g, "<path>").slice(0, 300);
}
