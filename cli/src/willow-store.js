// Polyfill Promise.withResolvers for Node < 22 (used internally by @earthstar/willow Store).
if (!Promise.withResolvers) {
  Promise.withResolvers = function () {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

/**
 * Willow Store backing for the local agent — v2.
 *
 * Uses the official @earthstar/willow Store + EntryDriverKvStore wired to a
 * thin KvDriverSqlite (cli/src/willow/kv-driver-sqlite.js) so all entry
 * metadata is stored in a structured key-value table (willow_kv) inside the
 * same SQLite file. Payloads are held in-memory via PayloadDriverMemory.
 *
 * Backwards-compatibility:
 *   The `yjs_entries` table is maintained as a mirror of each Store write so
 *   that existing scenario tests (87, 88, 92, 119) and willow-sync.js can
 *   continue querying it directly without change.
 *
 * Exported API (unchanged from v1):
 *   appendUpdate(root, docId, bytes, kind?)  → { seq, digest }
 *   listEntries(root, docId)                 → [{ seq, payload, digest, created_at, kind }]
 *   compactToSnapshot(root, docId, bytes)    → { seq, digest }
 *   statsForDoc(root, docId)                 → { count, bytes, last_seq, last_at }
 *   listDocs(root)                           → [{ doc_id, entries }]
 *   maybeCompact(root, docId)                → Promise<void>
 *
 * File layout: <root>/.aindrive/willow.db  (unchanged)
 * Tables:
 *   willow_kv    — generic packed KV store backing the official Store
 *   yjs_entries  — mirror / compatibility shim (same schema as v1)
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import * as Y from "yjs";

import { Store, EntryDriverKvStore, PayloadDriverMemory } from "@earthstar/willow";

import { KvDriverSqlite } from "./willow/kv-driver-sqlite.js";
import { storeSchemes } from "./willow/schemes.js";

// ─── DB / Store caches ────────────────────────────────────────────────────────

/** @type {Map<string, import('better-sqlite3').Database>} */
const dbCache = new Map();

/** @type {Map<string, Store>} */
const storeCache = new Map();

// Synthetic namespace pubkey per root: a deterministic 32-byte key derived
// from the root path (used when no .aindrive/config.json is present).
function syntheticNamespace(root) {
  return new Uint8Array(createHash("sha256").update("aindrive:ns:" + root).digest());
}

function open(root) {
  if (dbCache.has(root)) return dbCache.get(root);

  const dir = join(root, ".aindrive");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const db = new Database(join(dir, "willow.db"));
  db.pragma("journal_mode = WAL");

  // Mirror table — same schema as v1, kept for scenario + willow-sync compatibility
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

/**
 * Return (or create) the official Willow Store for a given root directory.
 * Each root gets one Store instance, backed by KvDriverSqlite.
 */
function getStore(root) {
  if (storeCache.has(root)) return storeCache.get(root);

  const db = open(root);
  const kvDriver = new KvDriverSqlite(db);

  const namespace = syntheticNamespace(root);

  const entryDriver = new EntryDriverKvStore({
    namespaceScheme: storeSchemes.namespace,
    subspaceScheme: storeSchemes.subspace,
    payloadScheme: storeSchemes.payload,
    pathScheme: storeSchemes.path,
    fingerprintScheme: storeSchemes.fingerprint,
    kvDriver,
    getPayloadLength: (digest) => payloadDriver.length(digest),
  });

  const payloadDriver = new PayloadDriverMemory(storeSchemes.payload);

  const store = new Store({
    namespace,
    schemes: storeSchemes,
    entryDriver,
    payloadDriver,
  });

  storeCache.set(root, store);
  return store;
}

// ─── Mirror helper ────────────────────────────────────────────────────────────

/**
 * Write a row to yjs_entries (the compatibility mirror table).
 * Returns { seq, digest } matching the v1 API shape.
 */
function mirrorAppend(db, docId, updateBytes, kind, digestBase64url) {
  const lastSeq =
    db.prepare("SELECT MAX(seq) AS s FROM yjs_entries WHERE doc_id = ?").get(docId)?.s ?? 0;
  const seq = lastSeq + 1;
  db.prepare(
    "INSERT INTO yjs_entries (doc_id, seq, payload, digest, created_at, kind) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(docId, seq, Buffer.from(updateBytes), digestBase64url, Date.now(), kind);
  return { seq, digest: digestBase64url };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Append a Y.js update (or any binary payload) as a new Willow entry for the
 * given docId (subspace). Each call creates a fresh entry with a unique
 * monotonic timestamp path ['yjs', <timestamp_us>].
 *
 * @param {string} root
 * @param {string} docId
 * @param {Uint8Array|Buffer} updateBytes
 * @param {'update'|'snapshot'} kind
 * @returns {{ seq: number, digest: string }}
 */
export function appendUpdate(root, docId, updateBytes, kind = "update") {
  const db = open(root);
  const store = getStore(root);

  const bytes = updateBytes instanceof Uint8Array ? updateBytes : new Uint8Array(updateBytes);
  const digest = createHash("sha256").update(bytes).digest("base64url");

  // Fire-and-forget Store write (async, but we return immediately from the mirror)
  const tsUs = BigInt(Date.now()) * 1000n;
  store.set(
    {
      path: [new TextEncoder().encode("yjs"), bigintToBytes(tsUs)],
      subspace: docId,
      payload: bytes,
      timestamp: tsUs,
    },
    undefined // no-op authorisation
  ).catch((e) => console.warn("[willow] store.set error:", e?.message));

  // Synchronous mirror write for callers that need the result immediately
  return mirrorAppend(db, docId, bytes, kind, digest);
}

/**
 * Read all relevant entries for a docId, starting from the latest snapshot.
 * Returns entries sorted oldest-first, matching the v1 shape.
 *
 * @param {string} root
 * @param {string} docId
 * @returns {Array<{ seq: number, payload: Buffer, digest: string, created_at: number, kind: string }>}
 */
export function listEntries(root, docId) {
  const db = open(root);

  const lastSnapshot = db.prepare(
    "SELECT MAX(seq) AS s FROM yjs_entries WHERE doc_id = ? AND kind = 'snapshot'"
  ).get(docId)?.s;
  const fromSeq = lastSnapshot ?? 0;

  return db.prepare(
    "SELECT seq, payload, digest, created_at, kind FROM yjs_entries WHERE doc_id = ? AND seq >= ? ORDER BY seq ASC"
  ).all(docId, fromSeq);
}

/**
 * Compact: encode current state as a snapshot, write it as a new entry, and
 * delete all older entries.
 *
 * @param {string} root
 * @param {string} docId
 * @param {Uint8Array|Buffer} snapshotBytes
 * @returns {{ seq: number, digest: string }}
 */
export function compactToSnapshot(root, docId, snapshotBytes) {
  const db = open(root);
  const store = getStore(root);

  const bytes = snapshotBytes instanceof Uint8Array ? snapshotBytes : new Uint8Array(snapshotBytes);
  const digest = createHash("sha256").update(bytes).digest("base64url");

  const result = db.transaction(() => {
    const lastSeq =
      db.prepare("SELECT MAX(seq) AS s FROM yjs_entries WHERE doc_id = ?").get(docId)?.s ?? 0;
    const seq = lastSeq + 1;
    db.prepare(
      "INSERT INTO yjs_entries (doc_id, seq, payload, digest, created_at, kind) VALUES (?, ?, ?, ?, ?, 'snapshot')"
    ).run(docId, seq, Buffer.from(bytes), digest, Date.now());
    db.prepare("DELETE FROM yjs_entries WHERE doc_id = ? AND seq < ?").run(docId, seq);
    return { seq, digest };
  })();

  // Also write snapshot to the Willow Store
  const tsUs = BigInt(Date.now()) * 1000n;
  store.set(
    {
      path: [new TextEncoder().encode("yjs"), new TextEncoder().encode("snapshot")],
      subspace: docId,
      payload: bytes,
      timestamp: tsUs,
    },
    undefined
  ).catch((e) => console.warn("[willow] store.set snapshot error:", e?.message));

  return result;
}

/**
 * Return aggregate stats for a docId.
 *
 * @param {string} root
 * @param {string} docId
 * @returns {{ count: number, bytes: number, last_seq: number, last_at: number }}
 */
export function statsForDoc(root, docId) {
  const db = open(root);
  return db.prepare(`
    SELECT COUNT(*) AS count,
           SUM(LENGTH(payload)) AS bytes,
           MAX(seq) AS last_seq,
           MAX(created_at) AS last_at
    FROM yjs_entries WHERE doc_id = ?
  `).get(docId);
}

/**
 * List all docs in the store with their entry counts.
 *
 * @param {string} root
 * @returns {Array<{ doc_id: string, entries: number }>}
 */
export function listDocs(root) {
  const db = open(root);
  return db.prepare(
    "SELECT doc_id, COUNT(*) AS entries FROM yjs_entries GROUP BY doc_id"
  ).all();
}

// ─── Auto-compaction ──────────────────────────────────────────────────────────

const COMPACT_MAX_UPDATES = 50;
const COMPACT_MAX_BYTES   = 1 * 1024 * 1024; // 1 MB
const COMPACT_MAX_AGE_MS  = 10 * 60 * 1000;  // 10 minutes

const _compacting = new Set();

/**
 * Check compaction thresholds and, if exceeded, merge all updates into a
 * single snapshot via compactToSnapshot. Safe to call concurrently.
 *
 * @param {string} root
 * @param {string} docId
 * @returns {Promise<void>}
 */
export async function maybeCompact(root, docId) {
  const key = `${root}::${docId}`;
  if (_compacting.has(key)) return;
  _compacting.add(key);
  try {
    const db = open(root);

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

    // Replay all entries into a Y.Doc and produce a snapshot
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

// ─── Internal util ────────────────────────────────────────────────────────────

/** Encode a BigInt timestamp as an 8-byte big-endian Uint8Array for path components. */
function bigintToBytes(n) {
  const buf = new Uint8Array(8);
  let v = n;
  for (let i = 7; i >= 0; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}
