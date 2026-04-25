import WebSocket from "ws";
import { watch } from "node:fs";
import { hostname as osHostname } from "node:os";
import { join, relative, sep } from "node:path";
import { handleRpc, cliTrace, docIdFor, setTraceServer, isSelfWrite } from "./rpc.js";
import { signPayload, verifyPayload, stripSig } from "./sig.js";
import { attachSync } from "./willow-sync.js";
import { log } from "./logger.js";

const PROTOCOL_VERSION = 1;
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000];
const FS_DEBOUNCE_MS = 500;
const DRAIN_TIMEOUT_MS = 10_000;

// Graceful shutdown state — module-level so signal handlers can reach it.
let shuttingDown = false;
let inFlightCount = 0;
let activeWs = null; // set by connectOnce while open

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
      await new Promise((r) => setTimeout(r, 50));
    }
    if (inFlightCount > 0) {
      log.warn({ inFlightCount }, "drain timeout — forcing close with pending RPCs");
    }

    // Close the WebSocket cleanly
    if (activeWs && activeWs.readyState === WebSocket.OPEN) {
      try { activeWs.close(1001, "agent shutting down"); } catch {}
      // Give the close handshake a moment
      await new Promise((r) => setTimeout(r, 200));
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

  while (!shuttingDown) {
    try {
      await connectOnce({ root, drive, wsUrl });
      attempt = 0;
    } catch (e) {
      log.error({ err: e.message || String(e) }, "agent connection error");
    }
    if (shuttingDown) break;
    const wait = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
    attempt++;
    log.info({ waitSec: wait / 1000 }, "reconnecting");
    await new Promise((r) => setTimeout(r, wait));
  }
}

function toWsUrl(server, driveId) {
  const u = new URL(`/api/agent/connect?driveId=${encodeURIComponent(driveId)}`, server);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

function connectOnce({ root, drive, wsUrl }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: { authorization: `Bearer ${drive.agentToken}` },
      handshakeTimeout: 10_000,
    });

    let opened = false;

    let watcher = null;
    const recentChanges = new Map(); // path → debounce timer

    ws.once("open", () => {
      opened = true;
      activeWs = ws;
      log.info({ driveId: drive.driveId }, "connected");
      // Tell the server which machine this agent is running on so it can show
      // the hostname next to the drive in the UI.
      try { ws.send(JSON.stringify({ type: "agent-hello", hostname: osHostname() })); } catch {}
      // Multi-device sync: gossip yjs_entries with peers via the same WS
      try { attachSync(ws, drive, root); } catch (e) { log.warn({ err: e.message }, "attachSync failed"); }
      // Start fs watcher — sends {type:'fs-changed', path} frames so the server can
      // broadcast 'reload' to any open editors of that path.
      try {
        watcher = watch(root, { recursive: true }, (event, filename) => {
          if (!filename) return;
          const rel = filename.split(sep).join("/");
          if (rel.startsWith(".aindrive/") || rel === ".aindrive") return;
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
      } catch (e) { log.warn({ err: e.message }, "fs.watch unavailable"); }
    });

    ws.on("message", async (data) => {
      log.debug({ raw: data.toString("utf8").slice(0, 200) }, "[agent recv]");
      let frame;
      try { frame = JSON.parse(data.toString("utf8")); }
      catch (e) { log.debug({ err: e.message }, "[agent recv] parse fail"); return; }
      if (frame?.type === "hello") { log.debug("[agent recv] hello"); return; }
      if (frame?.type !== "request" || !frame.reqId) { log.debug({ type: frame?.type }, "[agent recv] ignored"); return; }
      if (frame.v !== PROTOCOL_VERSION) { log.debug({ v: frame.v }, "[agent] bad version"); return; }
      const { sig, type, ...rest } = frame;
      log.debug({ sig: sig?.slice(0,8), keys: Object.keys(rest).sort().join(",") }, "[agent] verifying");
      const verified = verifyPayload(drive.driveSecret, rest, sig);
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

    ws.once("close", (code, reason) => {
      const msg = `disconnected${code ? ` (${code}${reason ? `: ${reason.toString()}` : ""})` : ""}`;
      if (activeWs === ws) activeWs = null;
      if (watcher) { try { watcher.close(); } catch {} }
      for (const t of recentChanges.values()) clearTimeout(t);
      recentChanges.clear();
      if (opened) { log.info({ msg }, "disconnected"); resolve(); }
      else reject(new Error(msg));
    });

    ws.once("error", (e) => {
      if (!opened) reject(new Error(`connect failed: ${e.message}`));
    });
  });
}

function sanitize(msg) {
  return String(msg || "error").replace(/\/[A-Za-z0-9_./-]+/g, "<path>").slice(0, 300);
}
