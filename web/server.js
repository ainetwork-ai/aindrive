// MUST be first: populates process.env from .env.local before the lib
// imports below (db / dochub / migrations) read AINDRIVE_* at import time.
import "./lib/load-env.js";
import { createServer } from "node:http";
import { parse as parseUrl } from "node:url";
import next from "next";
import { WebSocketServer } from "ws";
import { onAgentConnect } from "./lib/agents.js";
import { onDocConnect } from "./lib/dochub.js";
import { log } from "./lib/logger.js";
import { runBootChecks } from "./lib/boot-checks.js";
import { runAllMigrations } from "./lib/migrations/run.js";

runBootChecks();
runAllMigrations();

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "0.0.0.0";
const port = Number(process.env.PORT || 3737);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

await app.prepare();

const server = createServer((req, res) => {
  handle(req, res, parseUrl(req.url, true));
});

// maxPayload caps a single WS frame. The default (100 MB) is too small once a
// base64-encoded upload/download (×1.33) rides one RPC message — a ~75 MB file
// already overflows it and drops the agent connection. 160 MB keeps the 100 MB
// fs-write cap (≈133 MB base64) within one frame. Large-file streaming is the
// real fix (follow-up); this just makes the existing limits consistent.
const wss = new WebSocketServer({ noServer: true, maxPayload: 160 * 1024 * 1024 });

server.on("upgrade", (req, socket, head) => {
  const { pathname, query } = parseUrl(req.url, true);
  if (pathname === "/api/agent/connect") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      onAgentConnect(ws, req, query).catch((e) => {
        log.error({ err: e?.message || String(e) }, "agent connect error");
        try { ws.close(1011, "internal error"); } catch {}
      });
    });
    return;
  }
  if (pathname === "/api/agent/doc") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      onDocConnect(ws, req, query).catch((e) => {
        log.error({ err: e?.message || String(e) }, "doc connect error");
        try { ws.close(1011, "internal error"); } catch {}
      });
    });
    return;
  }
  socket.destroy();
});

server.listen(port, hostname, () => {
  const shown = hostname === "0.0.0.0" ? "localhost" : hostname;
  log.info({ url: `http://${shown}:${port}` }, "▲ aindrive");
});

// Graceful shutdown: stop accepting new connections, drain in-flight
// requests and WebSocket connections up to 30 s, then exit cleanly.
function shutdown(signal) {
  log.info({ signal }, "shutting down");

  // Stop accepting new HTTP connections.
  server.close(() => {
    log.info("http server closed");
  });

  // Close the WebSocket server (sends close frames to connected clients).
  wss.close(() => {
    log.info("websocket server closed");
  });

  // Hard exit after 30 s if draining takes too long.
  const forceExit = setTimeout(() => {
    log.warn("drain timeout — forcing exit");
    process.exit(1);
  }, 30_000);
  // Allow the timeout to be garbage-collected rather than keeping the event
  // loop alive once everything has drained naturally.
  if (forceExit.unref) forceExit.unref();

  // Exit cleanly once both server and wss have closed.
  let closed = 0;
  function onClosed() {
    if (++closed >= 2) {
      clearTimeout(forceExit);
      process.exit(0);
    }
  }
  server.once("close", onClosed);
  wss.once("close", onClosed);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
