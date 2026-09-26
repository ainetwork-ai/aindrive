// Signalling for the direct device → browser path (P2P media spec M5). The server
// only introduces the two ends: it gates the browser exactly like fs/stream (member,
// role on the path, paywall), hands it the file's manifest, and relays WebRTC offer /
// answer / ICE between that browser and the drive's agent. Every frame to the agent
// carries a token (drive, path, content root, expiry) signed with the drive secret,
// which the agent checks before serving a single chunk.
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { db } from "@/lib/db.js";
import { callAgent } from "@/lib/rpc";
import { sendToAgent } from "@/lib/agents.js";
import { normalizePath } from "@/lib/path";
import { isMember, paywalled, roleOf } from "@/lib/willow/roles";
import { mediaManifest } from "@/lib/media/cache";
import { mintToken } from "@/shared/media/p2p";
import { toHex } from "@/shared/willow/bytes";

const RANK: Record<string, number> = { none: 0, viewer: 1, commenter: 2, editor: 3, owner: 4 };
const TOKEN_MS = 10 * 60_000;
type Session = { ws: WebSocket; driveId: string };
const sessions: Map<string, Session> = ((globalThis as unknown as { __aindrive_rtc?: Map<string, Session> }).__aindrive_rtc ??= new Map());

/** A frame from an agent: `{type: "rtc", sid, data}` goes to the browser of that session only. */
export function routeFromAgent(driveId: string, msg: { type: string; sid?: unknown; data?: unknown }) {
  const s = typeof msg.sid === "string" ? sessions.get(msg.sid) : undefined;
  if (!s || s.driveId !== driveId || s.ws.readyState !== s.ws.OPEN) return;
  try { s.ws.send(JSON.stringify({ t: "signal", data: msg.data })); } catch {}
}

/** WS /api/media/rtc?drive=<id>&path=<file> */
export async function onRtcSignal(ws: WebSocket, _req: IncomingMessage, query: Record<string, unknown>, userId: string | null) {
  const driveId = String(query.drive ?? "");
  let path: string;
  try { path = normalizePath(String(query.path ?? "")); } catch { ws.close(4400, "invalid path"); return; }
  if (!driveId || !path || !isMember(driveId, userId)) { ws.close(4401, "no access"); return; }
  if ((RANK[roleOf(driveId, userId, path)] ?? 0) < RANK.viewer) { ws.close(4401, "no access"); return; }
  if (paywalled(driveId, userId, path)) { ws.close(4402, "payment required"); return; }
  const row = db.prepare("SELECT drive_secret FROM drives WHERE id = ?").get(driveId) as { drive_secret: string } | undefined;
  if (!row) { ws.close(4404, "no such drive"); return; }

  // registered before any await: a browser that leaves early leaves nothing behind (review M2)
  let sid: string | null = null, token = "";
  let closed = false;
  ws.on("close", () => {
    closed = true;
    if (!sid) return;
    sessions.delete(sid);
    sendToAgent(driveId, { type: "rtc", sid, token, path, data: { bye: true } });
  });

  let manifest, stat;
  try {
    stat = ((await callAgent(driveId, row.drive_secret, { method: "stat", path })) as unknown as { entry: { size: number; mtimeMs: number; isDir: boolean } | null }).entry;
    if (!stat || stat.isDir) { ws.close(4404, "not found"); return; }
    manifest = await mediaManifest(driveId, row.drive_secret, path, stat);
  } catch { ws.close(4503, "device unreachable"); return; }
  if (!manifest) { ws.close(4501, "device cannot serve chunks directly"); return; }
  if (closed) return;

  sid = randomBytes(12).toString("base64url");
  token = mintToken(row.drive_secret, { drive: driveId, path, root: manifest.rootHex, exp: Date.now() + TOKEN_MS, size: stat.size, mtimeMs: stat.mtimeMs });
  sessions.set(sid, { ws, driveId });
  const leaves = Array.from({ length: manifest.outboard.length / 32 }, (_, i) => toHex(manifest.outboard.subarray(i * 32, i * 32 + 32)));
  ws.send(JSON.stringify({ t: "ready", sid, manifest: { size: manifest.size, root: manifest.rootHex, leaves } }));

  ws.on("message", (raw) => {
    let f: { t?: string; data?: unknown };
    try { f = JSON.parse(String(raw)); } catch { return; }
    if (f.t === "signal" && sid) sendToAgent(driveId, { type: "rtc", sid, token, path, data: f.data });
  });
}

// agents.js hands agent "rtc" frames to this module without importing it (server.js bundles it)
(globalThis as unknown as { __aindrive_rtc_route?: typeof routeFromAgent }).__aindrive_rtc_route = routeFromAgent;
