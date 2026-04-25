import WebSocket from "ws";
import { watch } from "node:fs";
import { join, relative, sep } from "node:path";
import { handleRpc, cliTrace, docIdFor, setTraceServer, isSelfWrite } from "./rpc.js";
import { signPayload, verifyPayload, stripSig } from "./sig.js";
import { attachSync } from "./willow-sync.js";
import { log } from "./logger.js";

const PROTOCOL_VERSION = 1;
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000];
const FS_DEBOUNCE_MS = 500;

export async function runAgent({ root, drive, server }) {
  setTraceServer(server); // direct trace POSTs to the right server
  const wsUrl = toWsUrl(server, drive.driveId);
  let attempt = 0;
  let stopped = false;

  const shutdown = () => { if (!stopped) { stopped = true; process.exit(0); } };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (!stopped) {
    try {
      await connectOnce({ root, drive, wsUrl });
      attempt = 0;
    } catch (e) {
      log.error({ err: e.message || String(e) }, "agent connection error");
    }
    if (stopped) break;
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
      log.info({ driveId: drive.driveId }, "connected");
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
      log.debug({ method: frame.params?.method }, "[agent] handling");
      let response;
      try {
        const result = await handleRpc(frame.params, root);
        log.debug({ entries: result?.entries?.length }, "[agent] handleRpc ok");
        response = { type: "response", reqId: frame.reqId, ok: true, result };
      } catch (e) {
        log.error({ err: e.message }, "[agent] handleRpc threw");
        response = { type: "response", reqId: frame.reqId, ok: false, error: sanitize(e.message) };
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
