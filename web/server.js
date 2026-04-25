import { createServer } from "node:http";
import { parse as parseUrl } from "node:url";
import next from "next";
import { WebSocketServer } from "ws";
import { onAgentConnect } from "./lib/agents.js";
import { onDocConnect } from "./lib/dochub.js";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "0.0.0.0";
const port = Number(process.env.PORT || 3737);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

await app.prepare();

const server = createServer((req, res) => {
  handle(req, res, parseUrl(req.url, true));
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const { pathname, query } = parseUrl(req.url, true);
  if (pathname === "/api/agent/connect") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      onAgentConnect(ws, req, query).catch((e) => {
        console.error("agent connect error:", e?.message || e);
        try { ws.close(1011, "internal error"); } catch {}
      });
    });
    return;
  }
  if (pathname === "/api/agent/doc") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      onDocConnect(ws, req, query).catch((e) => {
        console.error("doc connect error:", e?.message || e);
        try { ws.close(1011, "internal error"); } catch {}
      });
    });
    return;
  }
  socket.destroy();
});

server.listen(port, hostname, () => {
  const shown = hostname === "0.0.0.0" ? "localhost" : hostname;
  console.log(`▲ aindrive  http://${shown}:${port}`);
});
