// Change feed — the origin side of ain-integration plan task 10 (docs/10-change-
// propagation.md §1, aindrive row). Plain ESM on purpose: lib/agents.js runs
// under `node server.js` with no TypeScript loader, and it is where the socket
// connect/disconnect and `fs-changed` frames arrive. The typed contract façade,
// the page reader and the routes live in lib/share-events.ts.
//
// One row per (event, recipient). A `resource_key` is the contract's resource
// id, `<origin>#<driveId>#<fileId>` with the same Phase A `p1:` id the shared-
// file list mints (lib/shared-items.ts sharedFileId — mirrored here, and pinned
// equal by lib/__tests__/share-events.test.ts). `version` is strictly
// increasing per resource_key across every recipient (share_event_versions), so
// a consumer's `applyEvents` reducer can drop stale and duplicate events. Events
// are hints: every real read re-checks the grant (resolveRoleByUser).
import { createHash } from "node:crypto";
import { db } from "./db.js";
import { normalizePath, isAncestorOrSelf } from "./path.js";

export const FILE_EVENT_TYPES = Object.freeze(["file.shared", "file.updated", "file.renamed", "file.moved", "file.deleted", "file.revoked", "file.availability"]);
/**
 * Rows kept per recipient; older ones are pruned on write and their seqs become
 * the recipient's gap floor. 10 000 unless AINDRIVE_SHARE_EVENT_RETENTION says
 * otherwise (tests use a small window).
 */
export const RETENTION_PER_RECIPIENT = Number(process.env.AINDRIVE_SHARE_EVENT_RETENTION) > 0 ? Math.floor(Number(process.env.AINDRIVE_SHARE_EVENT_RETENTION)) : 10_000;

const PATH_ID_PREFIX = "p1:";

/** The contract's spelling of a path: NFC, forward slashes, no ''/'.' segments, leading '/'. */
export function eventContractPath(p) {
  const parts = String(p ?? "").replace(/\\/g, "/").normalize("NFC").split("/").filter((s) => s !== "" && s !== ".");
  return "/" + parts.join("/");
}

/** Phase A file id — identical to lib/shared-items.ts sharedFileId. */
export function eventFileId(driveId, path) {
  return PATH_ID_PREFIX + createHash("sha256").update(driveId + "\0" + eventContractPath(path)).digest("hex").slice(0, 32);
}

/** This server's public origin, as lib/env.ts publicUrl spells it (duplicated: env.ts is TypeScript). */
export function eventOrigin(origin) {
  return (origin || process.env.AINDRIVE_PUBLIC_URL || `http://localhost:${process.env.PORT || 3737}`).replace(/\/$/, "");
}

/** `<origin>#<driveId>#<fileId>` — the resource id every product compares. */
export function resourceKey(driveId, path, origin) {
  return `${eventOrigin(origin)}#${driveId}#${eventFileId(driveId, path)}`;
}

/** Weak revision, as the shared-file list spells it: `m<mtimeMs>-s<size>`. */
export const eventRevision = (e) => `m${e?.mtimeMs ?? 0}-s${e?.size ?? 0}`;

// Statements are prepared per call (cheap; a low-frequency path) so nothing
// native outlives a request.
const SQL = {
  version: "SELECT version FROM share_event_versions WHERE resource_key = ?",
  bump: "INSERT INTO share_event_versions (resource_key, version) VALUES (?, ?) ON CONFLICT(resource_key) DO UPDATE SET version = excluded.version",
  insert: "INSERT INTO share_events (recipient_user_id, resource_key, drive_id, path, type, version, revision, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  cutoff: "SELECT seq FROM share_events WHERE recipient_user_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?",
  prune: "DELETE FROM share_events WHERE recipient_user_id = ? AND seq <= ?",
  floor: "INSERT INTO share_event_floors (recipient_user_id, pruned_to) VALUES (?, ?) ON CONFLICT(recipient_user_id) DO UPDATE SET pruned_to = max(share_event_floors.pruned_to, excluded.pruned_to)",
};

/** Keep the newest RETENTION_PER_RECIPIENT rows of one recipient; remember the highest pruned seq. */
function pruneRecipient(recipientUserId) {
  const edge = db.prepare(SQL.cutoff).get(recipientUserId, RETENTION_PER_RECIPIENT);
  if (!edge) return;
  db.prepare(SQL.prune).run(recipientUserId, edge.seq);
  db.prepare(SQL.floor).run(recipientUserId, edge.seq);
}

/**
 * Record one change of one resource for a set of recipients. All recipients
 * get the same, freshly bumped `version` (one version per change, whoever it
 * is addressed to). Returns `{ version, seqs }`; a call with no recipients
 * records nothing and returns `{ version: null, seqs: [] }`.
 *
 * @param {{ driveId: string, path: string, type: string, recipients: Iterable<string>, revision?: string|null, origin?: string, occurredAt?: string }} ev
 */
export function recordShareEvent(ev) {
  if (!FILE_EVENT_TYPES.includes(ev.type)) throw new Error(`unknown share event type: ${ev.type}`);
  const recipients = [...new Set([...ev.recipients].filter((r) => typeof r === "string" && r.length > 0))];
  if (recipients.length === 0) return { version: null, seqs: [] };
  let path;
  try { path = normalizePath(ev.path ?? ""); } catch { path = String(ev.path ?? ""); }
  const key = resourceKey(ev.driveId, path, ev.origin);
  const occurredAt = ev.occurredAt ?? new Date().toISOString();
  const revision = ev.revision ?? null;
  const tx = db.transaction(() => {
    const version = (db.prepare(SQL.version).get(key)?.version ?? 0) + 1;
    db.prepare(SQL.bump).run(key, version);
    const insert = db.prepare(SQL.insert);
    const seqs = [];
    for (const r of recipients) {
      seqs.push(Number(insert.run(r, key, ev.driveId, path, ev.type, version, revision, occurredAt).lastInsertRowid));
      pruneRecipient(r);
    }
    return { version, seqs };
  });
  return tx();
}

/**
 * Who hears about a drive: its creator plus every member (each once). With a
 * `path`, only members whose grant touches that path — a grant on the path or
 * an ancestor (they can reach it), or a grant below it (their folder moved
 * with it). Every path is normalised (NFC) before comparing.
 */
export function driveAudience(driveId, path) {
  const drive = db.prepare("SELECT owner_id FROM drives WHERE id = ?").get(driveId);
  const rows = db.prepare("SELECT user_id, path FROM drive_members WHERE drive_id = ?").all(driveId);
  const out = new Set();
  if (drive) out.add(drive.owner_id);
  let target = null;
  if (path !== undefined && path !== null) {
    try { target = normalizePath(path); } catch { target = null; }
  }
  for (const r of rows) {
    if (target === null) { out.add(r.user_id); continue; }
    let grant;
    try { grant = normalizePath(r.path); } catch { continue; }
    if (isAncestorOrSelf(grant, target) || isAncestorOrSelf(target, grant)) out.add(r.user_id);
  }
  return [...out];
}

// ── Hooks the write paths call ───────────────────────────────────────────────
//
// Every hook runs AFTER an irreversible write (a grant row, a settled payment,
// a socket flip) or inside another module's transaction, so it is best-effort:
// a feed failure is logged and never fails — or rolls back — the change it
// describes. The consumer's re-list on `gap` (and the origin's re-check on
// every read) cover a missed event. `recordShareEvent` itself still throws.

const NOTHING = Object.freeze({ version: null, seqs: [] });
function safe(what, fn) {
  try { return fn(); }
  catch (e) { console.warn(`[share-events] ${what} not recorded: ${e?.message || e}`); return NOTHING; }
}

/** A grant reached `userId` at `path` (invite, share-link accept, paid settle, signup claim). */
export function onMemberGranted(driveId, userId, path, opts = {}) {
  return safe("file.shared", () => recordShareEvent({ driveId, path, type: "file.shared", recipients: [userId], ...opts }));
}

/** `userId` lost the grants at `paths` (owner removed them, they left). One event per path. */
export function onMemberRevoked(driveId, userId, paths, opts = {}) {
  const out = [];
  for (const p of new Set(paths)) out.push(safe("file.revoked", () => recordShareEvent({ driveId, path: p, type: "file.revoked", recipients: [userId], ...opts })));
  return out;
}

/** Call BEFORE `DELETE FROM drives`: the member rows are cascaded away with it. */
export function onDriveDeleted(driveId, opts = {}) {
  return safe("file.deleted", () => recordShareEvent({ driveId, path: "", type: "file.deleted", recipients: driveAudience(driveId), ...opts }));
}

/**
 * The drive's agent came online or went offline (the `isOnline` answer flipped).
 * The caller decides the flip; this only records it, on the drive-root key.
 */
export function onAgentOnlineChanged(driveId, online, opts = {}) {
  return safe("file.availability", () => recordShareEvent({ driveId, path: "", type: "file.availability", recipients: driveAudience(driveId), revision: online ? "online" : "offline", ...opts }));
}

/**
 * The device reported a change at `path` (an `fs-changed` frame). The frame
 * names the path only — not whether it was written, renamed or removed — so
 * the caller stats it first: `exists: false` → `file.deleted`; otherwise
 * `file.updated` with the entry's revision. A rename therefore arrives as
 * `file.deleted` for the old key + `file.updated` for the new one (Phase A;
 * `file.moved` waits for the stable `f1:` ids). When the stat could not be
 * made (`exists: undefined`) the change is still reported as `file.updated`
 * without a revision.
 */
export function onFsChanged(driveId, path, info = {}, opts = {}) {
  let p;
  try { p = normalizePath(path); } catch { return NOTHING; }
  const type = info.exists === false ? "file.deleted" : "file.updated";
  const revision = info.exists && info.entry ? eventRevision(info.entry) : null;
  return safe(type, () => recordShareEvent({ driveId, path: p, type, recipients: driveAudience(driveId, p), revision, ...opts }));
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** Highest seq the retention prune removed for this recipient (0 = nothing pruned). */
/** The highest sequence number issued TO THIS RECIPIENT (0 when they have none): a cursor above it was never theirs. */
export function latestSeq(recipientUserId) {
  const row = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM share_events WHERE recipient_user_id = ?").get(recipientUserId);
  return row.seq;
}

export function prunedTo(recipientUserId) {
  return db.prepare("SELECT pruned_to FROM share_event_floors WHERE recipient_user_id = ?").get(recipientUserId)?.pruned_to ?? 0;
}

/**
 * The recipient's rows after `afterSeq`, oldest first, at most `limit`.
 * @returns {{ seq: number, resource_key: string, drive_id: string, path: string, type: string, version: number, revision: string|null, occurred_at: string }[]}
 */
export function readEventsAfter(recipientUserId, afterSeq, limit) {
  return db
    .prepare(
      "SELECT seq, resource_key, drive_id, path, type, version, revision, occurred_at FROM share_events WHERE recipient_user_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
    )
    .all(recipientUserId, afterSeq, limit);
}
