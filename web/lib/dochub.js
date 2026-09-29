import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { db } from "./db.js";
import { jwtVerify } from "jose";
import { trace } from "./trace.js";
import { log } from "./logger.js";
import { ROLE_RANK, bestMatchingRole, normalizePath } from "./access-core.js";
import { paidAccessDenial } from "./sale-access.js";
import { liveSessionUserId } from "./sso/store.js";
import { orgRoleInDrive } from "./orgs.js";

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
 *   docId → Set<{ ws, role, userId }>
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

// Mirrors lib/session.ts verify(): signature + expiry, then the same server-side
// gate (lib/sso/store.js) — a revoked epoch, an ended AIN SSO session or a
// suspended account gets no socket. `ses` names the SSO session, if any, so a
// back-channel logout can close exactly its sockets.
async function readSessionFromCookie(cookieHeader) {
  const m = /aindrive_session=([^;]+)/.exec(cookieHeader || "");
  if (!m) return { userId: null, ses: null };
  try {
    const { payload } = await jwtVerify(m[1], enc.encode(getSessionSecret()));
    const userId = liveSessionUserId(payload);
    return { userId, ses: userId && typeof payload.ses === "string" ? payload.ses : null };
  } catch { return { userId: null, ses: null }; }
}

/**
 * Closes live doc sockets of an account (`userId`) or of specific AIN SSO
 * sessions (`sessionIds`) — suspension and back-channel logout end sessions
 * server-side; this makes already-open editors notice. Registered on
 * globalThis so lib/sso/store.js (and the Next.js routes) reach this module's
 * hub map without importing the WebSocket server.
 */
export function disconnectPeers({ userId, sessionIds } = {}) {
  const ids = new Set(sessionIds ?? []);
  let closed = 0;
  for (const bucket of hubs.values()) {
    for (const peer of bucket) {
      if ((userId && peer.userId === userId) || (peer.ses && ids.has(peer.ses))) {
        try { peer.ws.close(4401, "session ended"); } catch {}
        closed++;
      }
    }
  }
  return closed;
}
globalThis.__aindrive_dochub_disconnect = disconnectPeers;

// Mirrors lib/access.ts resolveRoleByUser: drive owner, else the best grant —
// drive_members rows plus the whole-drive role of an organization the drive is
// shared with (lib/orgs.js, the same function access.ts calls). Kept here (not
// imported) because access.ts depends on next/headers, which is unavailable
// under raw `node server.js`. The grants decide the ROLE; the paid carve-out
// (paidAccessDenial, shared with the HTTP gate) then removes priced subtrees
// from a bare viewer's reach below.
function resolveGrant(driveId, userId, path) {
  if (!userId) return { role: "none", viaOrg: false };
  const target = normalizePath(path);
  const drive = db.prepare("SELECT owner_id FROM drives WHERE id = ?").get(driveId);
  if (!drive) return { role: "none", viaOrg: false };
  if (drive.owner_id === userId) return { role: "owner", viaOrg: false };
  const rows = db
    .prepare("SELECT path, role FROM drive_members WHERE drive_id = ? AND user_id = ?")
    .all(driveId, userId);
  const orgRole = orgRoleInDrive(driveId, userId);
  if (orgRole !== "none") rows.push({ path: "", role: orgRole });
  return { role: bestMatchingRole(rows, target), viaOrg: orgRole !== "none" };
}
function resolveRole(driveId, userId, path) {
  return resolveGrant(driveId, userId, path).role;
}

/** The peer's role now ("none" when it can't be read). */
function liveRole(peer) {
  try { return resolveRole(peer.driveId, peer.userId, peer.path); } catch { return "none"; }
}

/** Closes a socket whose access changed; the provider reconnects and gets the new role or "no access". */
function closeChanged(peer) {
  if (peer.closing) return false;
  peer.closing = true;
  try { peer.ws.close(4401, "access changed"); } catch {}
  return true;
}

/**
 * Re-checks every open doc socket on a drive after its grants changed in a
 * way that can take access away from people who are not signed out (an
 * organization share removed or lowered, or its creator's membership
 * suspended). A socket whose role changed closes. Registered on globalThis
 * for lib/orgs.js, like disconnectPeers.
 */
export function revalidateDrivePeers(driveId) {
  let closed = 0;
  for (const bucket of hubs.values()) {
    for (const peer of bucket) {
      if (peer.driveId !== driveId) continue;
      if (liveRole(peer) !== peer.role && closeChanged(peer)) closed++;
    }
  }
  return closed;
}
globalThis.__aindrive_dochub_revalidate = revalidateDrivePeers;

/**
 * Sockets whose access came through an organization are also re-checked on
 * their own, because an organization share can change where this process
 * does not see it: the operator script (scripts/org-drive.mjs) writes the DB
 * from another process. Every frame such a socket sends is checked first (so
 * an edit never lands after the share was lowered or removed), and all of
 * them are swept every ORG_PEER_RECHECK_MS (so a passive reader stops
 * receiving too). The sweep runs only while such sockets are open.
 */
export const ORG_PEER_RECHECK_MS = 5_000;
export function revalidateOrgPeers() {
  let closed = 0;
  let open = 0;
  for (const bucket of hubs.values()) {
    for (const peer of bucket) {
      if (!peer.viaOrg || peer.closing) continue;
      if (liveRole(peer) !== peer.role) { if (closeChanged(peer)) closed++; }
      else open++;
    }
  }
  return { closed, open };
}
function ensureOrgPeerSweep() {
  if (globalThis.__aindrive_dochub_org_sweep) return;
  const timer = setInterval(() => {
    let open = 0;
    try { open = revalidateOrgPeers().open; } catch (e) { log.warn({ err: e?.message }, "[doc] org re-check failed"); open = 1; }
    if (open === 0) { clearInterval(timer); globalThis.__aindrive_dochub_org_sweep = null; }
  }, ORG_PEER_RECHECK_MS);
  timer.unref?.();
  globalThis.__aindrive_dochub_org_sweep = timer;
}

export async function onDocConnect(ws, req, query) {
  const driveId = String(query?.drive || "");
  if (!driveId) { ws.close(4400, "drive required"); return; }
  // Canonicalize ONCE, as the fs/* routes do: the role, the paywall and the doc
  // key must all see one spelling ("./paid/a.md", "/paid/a.md" and the NFD form
  // are "paid/a.md"), or a variant slips past the gate stored under the other.
  let path;
  try { path = normalizePath(String(query?.path || "")); }
  catch { ws.close(4400, "invalid path"); return; }

  const cookie = req.headers["cookie"];
  const { userId, ses } = await readSessionFromCookie(cookie);
  const { role, viaOrg } = resolveGrant(driveId, userId, path);
  if (ROLE_RANK[role] < ROLE_RANK.viewer) { ws.close(4401, "no access"); return; }
  // Paid carve-out: a bare viewer must not siphon a priced doc's live frames over
  // WS any more than they can read it over HTTP (same rule, shared module).
  // editor+ and entitled buyers pass; an unentitled viewer is closed (paywall).
  if (paidAccessDenial(driveId, path, role, userId)) { ws.close(4402, "payment required"); return; }

  const docId = docIdFor(driveId, path);
  // viaOrg: an organization's role is part of this socket's access, so it is
  // re-checked on every frame and by the sweep (revalidateOrgPeers).
  const peer = { ws, role, userId, ses, docId, driveId, path, viaOrg, closing: false };
  let bucket = hubs.get(docId);
  if (!bucket) { bucket = new Set(); hubs.set(docId, bucket); }
  bucket.add(peer);
  if (viaOrg) ensureOrgPeerSweep();

  log.info({ docId, role, user: userId || "anon", peers: bucket.size }, "[doc] sub");
  try {
    ws.send(JSON.stringify({ t: "sub-ok", role, peers: bucket.size }));
  } catch {}
  try { trace("server", "ws-doc-sub", { docId, extra: { role, peers: bucket.size, userId } }); } catch {}

  ws.on("message", (data) => {
    let frame;
    try { frame = JSON.parse(data.toString("utf8")); } catch { return; }
    if (!frame || typeof frame.t !== "string") return;
    if (peer.closing) return;
    // Access through an organization can end without this process being told
    // (revalidateOrgPeers): check it before anything this socket sends lands.
    if (peer.viaOrg && liveRole(peer) !== peer.role) { closeChanged(peer); return; }
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
  let canonical;
  try { canonical = normalizePath(path); } catch { return 0; }
  const docId = docIdFor(driveId, canonical);
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
