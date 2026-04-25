/**
 * Multi-device sync for the local Willow Store.
 *
 * Full WGPS is heavy. For v1, we use a *minimal entry-diff protocol* over the
 * existing agent WebSocket — same drive secret, but every connected agent for
 * a given driveId broadcasts its yjs_entries summary, peers compute the diff,
 * and missing entries get pulled by digest.
 *
 * Frame types (server-side dochub already exists for browser editors; this is
 * agent-to-agent piggybacked on the same WS to /api/agent/connect):
 *   { type: 'sync-summary', docs: [{ docId, lastSeq, digests: [...] }] }
 *   { type: 'sync-want',    docId, digests: [...] }
 *   { type: 'sync-give',    docId, entries: [{ seq, kind, payload, digest, created_at }] }
 *
 * On a give, the receiver appends locally if it doesn't already have the digest.
 */
import { listDocs } from "./willow-store.js";
import Database from "better-sqlite3";
import { join } from "node:path";
import { log } from "./logger.js";

const SUMMARY_INTERVAL_MS = 30_000;
const MAX_DIGESTS_PER_SUMMARY = 100;

function db(root) {
  const handle = new Database(join(root, ".aindrive", "willow.db"));
  // Ensure schema exists — willow-store.open() may not have been called yet on this device
  handle.exec(`
    CREATE TABLE IF NOT EXISTS yjs_entries (
      doc_id TEXT NOT NULL, seq INTEGER NOT NULL,
      payload BLOB NOT NULL, digest TEXT NOT NULL,
      created_at INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'update',
      PRIMARY KEY (doc_id, seq)
    );
  `);
  return handle;
}

export function buildSummary(root) {
  const handle = db(root);
  try {
    const rows = handle.prepare(`
      SELECT doc_id, MAX(seq) AS last_seq FROM yjs_entries GROUP BY doc_id
    `).all();
    const docs = [];
    for (const r of rows) {
      const digests = handle.prepare(
        "SELECT digest FROM yjs_entries WHERE doc_id = ? ORDER BY seq DESC LIMIT ?"
      ).all(r.doc_id, MAX_DIGESTS_PER_SUMMARY).map((d) => d.digest);
      docs.push({ docId: r.doc_id, lastSeq: r.last_seq, digests });
    }
    return { type: "sync-summary", docs };
  } finally { handle.close(); }
}

export function digestsWeMissFrom(root, peerSummary) {
  const handle = db(root);
  try {
    const requests = [];
    for (const peer of peerSummary.docs) {
      const ours = new Set(
        handle.prepare("SELECT digest FROM yjs_entries WHERE doc_id = ?").all(peer.docId).map((r) => r.digest)
      );
      const missing = peer.digests.filter((d) => !ours.has(d));
      if (missing.length > 0) requests.push({ docId: peer.docId, digests: missing });
    }
    return requests;
  } finally { handle.close(); }
}

export function fulfillWant(root, docId, digests) {
  const handle = db(root);
  try {
    const placeholders = digests.map(() => "?").join(",");
    const rows = handle.prepare(
      `SELECT seq, kind, payload, digest, created_at FROM yjs_entries WHERE doc_id = ? AND digest IN (${placeholders})`
    ).all(docId, ...digests);
    return rows.map((r) => ({
      seq: r.seq,
      kind: r.kind,
      digest: r.digest,
      created_at: r.created_at,
      payload: Buffer.from(r.payload).toString("base64"),
    }));
  } finally { handle.close(); }
}

export function applyGive(root, docId, entries) {
  const handle = db(root);
  let applied = 0;
  try {
    const have = new Set(
      handle.prepare("SELECT digest FROM yjs_entries WHERE doc_id = ?").all(docId).map((r) => r.digest)
    );
    const lastSeqRow = handle.prepare("SELECT MAX(seq) AS s FROM yjs_entries WHERE doc_id = ?").get(docId);
    let nextSeq = (lastSeqRow?.s ?? 0) + 1;
    const insert = handle.prepare(
      "INSERT INTO yjs_entries (doc_id, seq, payload, digest, created_at, kind) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const tx = handle.transaction(() => {
      for (const e of entries) {
        if (have.has(e.digest)) continue;
        insert.run(docId, nextSeq++, Buffer.from(e.payload, "base64"), e.digest, e.created_at, e.kind);
        applied++;
      }
    });
    tx();
    return applied;
  } finally { handle.close(); }
}

/** Wire the sync protocol into an existing agent WebSocket connection. */
export function attachSync(ws, drive, root) {
  const send = (frame) => { try { ws.send(JSON.stringify(frame)); } catch {} };

  const sendSummary = () => {
    try {
      const summary = buildSummary(root);
      if (summary.docs.length > 0) send(summary);
    } catch (e) { log.warn({ err: e.message }, "[sync] summary failed"); }
  };

  // Periodic summary broadcast
  const interval = setInterval(sendSummary, SUMMARY_INTERVAL_MS);
  setTimeout(sendSummary, 1000); // initial after connect

  ws.on("message", (data) => {
    let frame;
    try { frame = JSON.parse(data.toString("utf8")); } catch { return; }
    if (!frame?.type) return;
    if (frame.type === "sync-summary") {
      try {
        const wants = digestsWeMissFrom(root, frame);
        for (const w of wants) {
          send({ type: "sync-want", docId: w.docId, digests: w.digests });
        }
      } catch (e) { log.warn({ err: e.message }, "[sync] handle summary"); }
    } else if (frame.type === "sync-want") {
      try {
        const entries = fulfillWant(root, frame.docId, frame.digests);
        if (entries.length > 0) {
          send({ type: "sync-give", docId: frame.docId, entries });
        }
      } catch (e) { log.warn({ err: e.message }, "[sync] handle want"); }
    } else if (frame.type === "sync-give") {
      try {
        const applied = applyGive(root, frame.docId, frame.entries);
        if (applied > 0) log.info({ applied, docId: frame.docId }, "[sync] applied entries");
      } catch (e) { log.warn({ err: e.message }, "[sync] handle give"); }
    }
  });

  ws.on("close", () => clearInterval(interval));
}
