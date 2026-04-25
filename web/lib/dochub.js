import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { db } from "./db.js";
import { jwtVerify } from "jose";
import { trace } from "./trace.js";
import { log } from "./logger.js";

function getSessionSecret() {
  if (process.env.AINDRIVE_SESSION_SECRET) return process.env.AINDRIVE_SESSION_SECRET;
  const dir = process.env.AINDRIVE_DATA_DIR || join(homedir(), ".aindrive");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "session-secret");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const secret = randomBytes(32).toString("hex");
  writeFileSync(file, secret);
  try { chmodSync(file, 0o600); } catch {}
  return secret;
}

/**
 * DocHub: per-document broadcast hub for collaborative editing.
 *
 *   docId → Set<{ ws, role, userId, address }>
 *
 * Each WS subscribes to exactly one (driveId, path) pair. When any frame arrives
 * from a subscriber, it is forwarded to every OTHER subscriber on the same docId.
 *
 * Wire frames:
 *   client → server  { t: 'sync',  msg }       y-protocols sync update (bytes b64)
 *   client → server  { t: 'aware', msg }       y-protocols awareness update (bytes b64)
 *   server → client  same shapes, mirrored from other peers
 *   server → client  { t: 'reload' }           agent told us the file changed on disk
 *   server → client  { t: 'sub-ok', role, peers }  initial ack
 *
 * The server is intentionally dumb — it does NOT parse Y.js bytes. It only
 * authorises (subscribe = viewer+, push = editor+) and broadcasts.
 */
const hubs = globalThis.__aindrive_dochubs ?? new Map();
if (!globalThis.__aindrive_dochubs) globalThis.__aindrive_dochubs = hubs;

const enc = new TextEncoder();

export function docIdFor(driveId, path) {
  return createHash("sha1").update(`${driveId}:${path}`).digest("base64url").slice(0, 22);
}

async function readWalletFromCookie(cookieHeader) {
  const m = /aindrive_wallet=([^;]+)/.exec(cookieHeader || "");
  if (!m) return null;
  try {
    const { payload } = await jwtVerify(m[1], enc.encode(getSessionSecret()));
    return ((payload.addr) || null)?.toLowerCase() ?? null;
  } catch { return null; }
}

async function readUserFromCookie(cookieHeader) {
  const m = /aindrive_session=([^;]+)/.exec(cookieHeader || "");
  if (!m) return null;
  try {
    const { payload } = await jwtVerify(m[1], enc.encode(getSessionSecret()));
    return (payload.sub) || null;
  } catch { return null; }
}

function isAncestorOrSelf(ancestor, target) {
  if (!ancestor) return true;
  if (ancestor === target) return true;
  return target.startsWith(ancestor + "/");
}

const ROLE_RANK = { none: 0, viewer: 1, commenter: 2, editor: 3, owner: 4 };

function resolveRole(driveId, userId, address, path) {
  const drive = db.prepare("SELECT owner_id FROM drives WHERE id = ?").get(driveId);
  if (!drive) return "none";
  if (userId && drive.owner_id === userId) return "owner";
  let best = "none";
  if (userId) {
    const members = db.prepare("SELECT path, role FROM drive_members WHERE drive_id = ? AND user_id = ?").all(driveId, userId);
    for (const m of members) {
      if (isAncestorOrSelf(m.path, path) && ROLE_RANK[m.role] > ROLE_RANK[best]) best = m.role;
    }
  }
  if (address) {
    const grants = db.prepare("SELECT path, role FROM folder_access WHERE drive_id = ? AND wallet_address = ?").all(driveId, address);
    for (const g of grants) {
      if (isAncestorOrSelf(g.path, path) && ROLE_RANK[g.role] > ROLE_RANK[best]) best = g.role;
    }
  }
  return best;
}

export async function onDocConnect(ws, req, query) {
  const driveId = String(query?.drive || "");
  const path = String(query?.path || "");
  if (!driveId) { ws.close(4400, "drive required"); return; }

  const cookie = req.headers["cookie"];
  const [userId, address] = await Promise.all([readUserFromCookie(cookie), readWalletFromCookie(cookie)]);
  const role = resolveRole(driveId, userId, address, path);
  if (ROLE_RANK[role] < ROLE_RANK.viewer) { ws.close(4401, "no access"); return; }

  const docId = docIdFor(driveId, path);
  const peer = { ws, role, userId, address, docId };
  let bucket = hubs.get(docId);
  if (!bucket) { bucket = new Set(); hubs.set(docId, bucket); }
  bucket.add(peer);

  log.info({ docId, role, user: userId || address || "anon", peers: bucket.size }, "[doc] sub");
  try {
    ws.send(JSON.stringify({ t: "sub-ok", role, peers: bucket.size }));
  } catch {}
  try { trace("server", "ws-doc-sub", { docId, extra: { role, peers: bucket.size, userId, address } }); } catch {}

  ws.on("message", (data) => {
    let frame;
    try { frame = JSON.parse(data.toString("utf8")); } catch { return; }
    if (!frame || typeof frame.t !== "string") return;
    // Authorisation: only editor+ may push sync updates.
    if (frame.t === "sync" && ROLE_RANK[peer.role] < ROLE_RANK.editor) return;
    // Forward to all OTHER peers in the same docId.
    const out = JSON.stringify(frame);
    for (const other of bucket) {
      if (other === peer) continue;
      if (other.ws.readyState === other.ws.OPEN) {
        try { other.ws.send(out); } catch {}
      }
    }
    try { trace("server", "ws-doc-fwd", { docId, byteLen: out.length, extra: { from: peer.role, t: frame.t, to: bucket.size - 1 } }); } catch {}
  });

  ws.on("close", () => {
    bucket.delete(peer);
    if (bucket.size === 0) hubs.delete(docId);
    log.info({ docId, peers: bucket.size }, "[doc] unsub");
    try { trace("server", "ws-doc-unsub", { docId, extra: { peers: bucket.size } }); } catch {}
  });

  ws.on("error", (e) => log.warn({ err: e.message }, "[doc] ws error"));
}

/** Used by the agent's external-edit watcher to invalidate live editors. */
export function broadcastReload(driveId, path) {
  const docId = docIdFor(driveId, path);
  const bucket = hubs.get(docId);
  if (!bucket) return 0;
  const out = JSON.stringify({ t: "reload" });
  let sent = 0;
  for (const peer of bucket) {
    if (peer.ws.readyState === peer.ws.OPEN) {
      try { peer.ws.send(out); sent++; } catch {}
    }
  }
  return sent;
}
