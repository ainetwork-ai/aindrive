/**
 * Minimal Willow Store backing for the local agent.
 *
 * Goal of v1: persist Y.js updates (binary) as Willow Entries inside a
 * single SQLite file at <root>/.aindrive/willow.db, keyed by (subspace=docId,
 * path=['yjs', timestamp]). Reading a doc replays all entries for that subspace
 * into a fresh Y.Doc via Y.applyUpdate.
 *
 * The full @earthstar/willow Store wiring with Meadowcap-Auth + WGPS is heavy
 * to set up correctly — for the agent's local-only persistence we use a small
 * direct table that mirrors the same shape (subspace, path, payload, timestamp,
 * digest) but skips the cap-checking layer. Multi-device sync (N4.3) will then
 * wrap this table behind real WGPS.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import * as Y from "yjs";

let dbCache = new Map(); // root → Database

function open(root) {
  if (dbCache.has(root)) return dbCache.get(root);
  const dir = join(root, ".aindrive");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new Database(join(dir, "willow.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS yjs_entries (
      doc_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      payload BLOB NOT NULL,
      digest TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'update' CHECK (kind IN ('update', 'snapshot')),
      PRIMARY KEY (doc_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_yjs_entries_doc ON yjs_entries(doc_id, created_at);
  `);
  dbCache.set(root, db);
  return db;
}

export function appendUpdate(root, docId, updateBytes, kind = "update") {
  const db = open(root);
  const digest = createHash("sha256").update(updateBytes).digest("base64url");
  const lastSeq = db.prepare("SELECT MAX(seq) AS s FROM yjs_entries WHERE doc_id = ?").get(docId)?.s ?? 0;
  const seq = lastSeq + 1;
  db.prepare(
    "INSERT INTO yjs_entries (doc_id, seq, payload, digest, created_at, kind) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(docId, seq, Buffer.from(updateBytes), digest, Date.now(), kind);
  return { seq, digest };
}

export function listEntries(root, docId) {
  const db = open(root);
  // Find the most recent snapshot, return all entries from that point onward
  const lastSnapshot = db.prepare(
    "SELECT MAX(seq) AS s FROM yjs_entries WHERE doc_id = ? AND kind = 'snapshot'"
  ).get(docId)?.s;
  const fromSeq = lastSnapshot ?? 0;
  return db.prepare(
    "SELECT seq, payload, digest, created_at, kind FROM yjs_entries WHERE doc_id = ? AND seq >= ? ORDER BY seq ASC"
  ).all(docId, fromSeq);
}

export function compactToSnapshot(root, docId, snapshotBytes) {
  const db = open(root);
  const tx = db.transaction(() => {
    const lastSeq = db.prepare("SELECT MAX(seq) AS s FROM yjs_entries WHERE doc_id = ?").get(docId)?.s ?? 0;
    const seq = lastSeq + 1;
    const digest = createHash("sha256").update(snapshotBytes).digest("base64url");
    db.prepare(
      "INSERT INTO yjs_entries (doc_id, seq, payload, digest, created_at, kind) VALUES (?, ?, ?, ?, ?, 'snapshot')"
    ).run(docId, seq, Buffer.from(snapshotBytes), digest, Date.now());
    // Drop everything older than this snapshot
    db.prepare("DELETE FROM yjs_entries WHERE doc_id = ? AND seq < ?").run(docId, seq);
    return { seq, digest };
  });
  return tx();
}

export function statsForDoc(root, docId) {
  const db = open(root);
  const row = db.prepare(`
    SELECT COUNT(*) AS count,
           SUM(LENGTH(payload)) AS bytes,
           MAX(seq) AS last_seq,
           MAX(created_at) AS last_at
    FROM yjs_entries WHERE doc_id = ?
  `).get(docId);
  return row;
}

export function listDocs(root) {
  const db = open(root);
  return db.prepare("SELECT doc_id, COUNT(*) AS entries FROM yjs_entries GROUP BY doc_id").all();
}

// Thresholds for auto-compaction
const COMPACT_MAX_UPDATES = 50;
const COMPACT_MAX_BYTES = 1 * 1024 * 1024; // 1 MB
const COMPACT_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

// In-flight compaction guard: prevents concurrent compactions for the same doc
const _compacting = new Set();

/**
 * maybeCompact checks whether the doc exceeds compaction thresholds and, if so,
 * replays all entries into a fresh Y.Doc, encodes state, and calls compactToSnapshot.
 * Safe to call concurrently — returns immediately if a compaction is already in progress.
 * Always resolves (never rejects); errors are logged as warnings.
 */
export async function maybeCompact(root, docId) {
  const key = `${root}::${docId}`;
  if (_compacting.has(key)) return;
  _compacting.add(key);
  try {
    const db = open(root);

    // Count non-snapshot (update) entries and their total payload size
    const stats = db.prepare(`
      SELECT COUNT(*) AS update_count,
             SUM(LENGTH(payload)) AS total_bytes,
             MIN(created_at) AS oldest_at
      FROM yjs_entries WHERE doc_id = ? AND kind = 'update'
    `).get(docId);

    if (!stats || stats.update_count === 0) return;

    const needsCompact =
      stats.update_count >= COMPACT_MAX_UPDATES ||
      (stats.total_bytes ?? 0) >= COMPACT_MAX_BYTES ||
      (Date.now() - (stats.oldest_at ?? Date.now())) >= COMPACT_MAX_AGE_MS;

    if (!needsCompact) return;

    // Replay all entries (snapshot + subsequent updates) into a Y.Doc
    const entries = db.prepare(
      "SELECT seq, payload, kind FROM yjs_entries WHERE doc_id = ? ORDER BY seq ASC"
    ).all(docId);

    const doc = new Y.Doc();
    for (const e of entries) {
      try { Y.applyUpdate(doc, new Uint8Array(e.payload)); } catch {}
    }
    const snapshotBytes = Y.encodeStateAsUpdate(doc);

    compactToSnapshot(root, docId, snapshotBytes);
  } catch (err) {
    console.warn(`[willow] maybeCompact(${docId}) failed:`, err.message);
  } finally {
    _compacting.delete(key);
  }
}
