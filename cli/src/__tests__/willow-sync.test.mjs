// Unit tests for willow-sync pure functions (buildSummary, digestsWeMissFrom,
// fulfillWant, applyGive). Each function opens its own SQLite handle against
// <root>/.aindrive/willow.db via the db() helper in willow-sync.js, which also
// runs CREATE TABLE IF NOT EXISTS — so we only need to create the .aindrive dir.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  buildSummary,
  digestsWeMissFrom,
  fulfillWant,
  applyGive,
} from "../willow-sync.js";

// Create a fresh tmp root with .aindrive/ so willow-sync db() can open willow.db.
// Call buildSummary once to trigger the db() schema bootstrap (CREATE TABLE IF NOT EXISTS),
// so subsequent insertEntry calls can insert without "no such table" errors.
function setupRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "willow-sync-test-"));
  mkdirSync(path.join(root, ".aindrive"), { recursive: true });
  // Bootstrap the DB schema by calling buildSummary (the db() helper creates the table)
  buildSummary(root);
  return root;
}

// Insert a row directly — bypasses willow-store so tests stay self-contained.
function insertEntry(root, { docId, seq, payload, digest, createdAt = Date.now(), kind = "update" }) {
  const handle = new Database(path.join(root, ".aindrive", "willow.db"));
  handle
    .prepare(
      "INSERT INTO yjs_entries (doc_id, seq, payload, digest, created_at, kind) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(docId, seq, Buffer.from(payload), digest, createdAt, kind);
  handle.close();
}

let root;
beforeEach(() => { root = setupRoot(); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("buildSummary", () => {
  it("returns an empty docs array when no entries exist", () => {
    const summary = buildSummary(root);
    expect(summary).toEqual({ type: "sync-summary", docs: [] });
  });

  it("returns one doc entry with lastSeq and digests", () => {
    insertEntry(root, { docId: "doc1", seq: 1, payload: "aaa", digest: "d1" });
    insertEntry(root, { docId: "doc1", seq: 2, payload: "bbb", digest: "d2" });
    const summary = buildSummary(root);
    expect(summary.type).toBe("sync-summary");
    expect(summary.docs).toHaveLength(1);
    const doc = summary.docs[0];
    expect(doc.docId).toBe("doc1");
    expect(doc.lastSeq).toBe(2);
    // digests ordered by seq DESC — most recent first
    expect(doc.digests).toEqual(["d2", "d1"]);
  });

  it("returns multiple docs", () => {
    insertEntry(root, { docId: "docA", seq: 1, payload: "x", digest: "dA1" });
    insertEntry(root, { docId: "docB", seq: 1, payload: "y", digest: "dB1" });
    const summary = buildSummary(root);
    const ids = summary.docs.map((d) => d.docId).sort();
    expect(ids).toEqual(["docA", "docB"]);
  });

  it("caps digests at MAX_DIGESTS_PER_SUMMARY (100)", () => {
    for (let i = 1; i <= 110; i++) {
      insertEntry(root, { docId: "bigdoc", seq: i, payload: `p${i}`, digest: `dig${i}` });
    }
    const summary = buildSummary(root);
    const doc = summary.docs.find((d) => d.docId === "bigdoc");
    expect(doc.digests.length).toBe(100);
  });
});

describe("digestsWeMissFrom", () => {
  it("returns empty array when we have everything the peer has", () => {
    insertEntry(root, { docId: "doc1", seq: 1, payload: "a", digest: "d1" });
    const peerSummary = { docs: [{ docId: "doc1", lastSeq: 1, digests: ["d1"] }] };
    expect(digestsWeMissFrom(root, peerSummary)).toEqual([]);
  });

  it("returns the missing digests for a doc we partially have", () => {
    insertEntry(root, { docId: "doc1", seq: 1, payload: "a", digest: "d1" });
    const peerSummary = {
      docs: [{ docId: "doc1", lastSeq: 2, digests: ["d2", "d1"] }],
    };
    const wants = digestsWeMissFrom(root, peerSummary);
    expect(wants).toHaveLength(1);
    expect(wants[0]).toEqual({ docId: "doc1", digests: ["d2"] });
  });

  it("returns all digests for a doc we do not have at all", () => {
    const peerSummary = {
      docs: [{ docId: "newdoc", lastSeq: 1, digests: ["dx"] }],
    };
    const wants = digestsWeMissFrom(root, peerSummary);
    expect(wants).toHaveLength(1);
    expect(wants[0].digests).toEqual(["dx"]);
  });

  it("returns nothing when the peer summary has no docs", () => {
    expect(digestsWeMissFrom(root, { docs: [] })).toEqual([]);
  });
});

describe("fulfillWant", () => {
  it("returns entries matching the requested digests", () => {
    insertEntry(root, { docId: "doc1", seq: 1, payload: "hello", digest: "d1" });
    insertEntry(root, { docId: "doc1", seq: 2, payload: "world", digest: "d2" });
    const entries = fulfillWant(root, "doc1", ["d1"]);
    expect(entries).toHaveLength(1);
    expect(entries[0].digest).toBe("d1");
    expect(entries[0].seq).toBe(1);
    // payload is returned as base64
    expect(Buffer.from(entries[0].payload, "base64").toString()).toBe("hello");
  });

  it("returns empty array when no digest matches", () => {
    expect(fulfillWant(root, "doc1", ["nonexistent"])).toEqual([]);
  });

  it("returns multiple entries for multiple digests", () => {
    insertEntry(root, { docId: "doc1", seq: 1, payload: "a", digest: "d1" });
    insertEntry(root, { docId: "doc1", seq: 2, payload: "b", digest: "d2" });
    const entries = fulfillWant(root, "doc1", ["d1", "d2"]);
    expect(entries).toHaveLength(2);
  });
});

describe("applyGive", () => {
  it("inserts new entries and returns the count applied", () => {
    const entries = [
      { seq: 1, kind: "update", digest: "d1", created_at: Date.now(), payload: Buffer.from("a").toString("base64") },
      { seq: 2, kind: "update", digest: "d2", created_at: Date.now(), payload: Buffer.from("b").toString("base64") },
    ];
    const applied = applyGive(root, "doc1", entries);
    expect(applied).toBe(2);
  });

  it("is idempotent — re-applying the same entries returns 0", () => {
    const entries = [
      { seq: 1, kind: "update", digest: "dX", created_at: Date.now(), payload: Buffer.from("x").toString("base64") },
    ];
    applyGive(root, "doc1", entries);
    const reapplied = applyGive(root, "doc1", entries);
    expect(reapplied).toBe(0);
  });

  it("assigns new sequential seq numbers (does not use the sender's seq)", () => {
    // applyGive sequences from (localMax + 1), ignoring incoming seq values
    insertEntry(root, { docId: "doc1", seq: 5, payload: "existing", digest: "dE" });
    const entries = [
      { seq: 1, kind: "update", digest: "dNew", created_at: Date.now(), payload: Buffer.from("new").toString("base64") },
    ];
    applyGive(root, "doc1", entries);
    const handle = new Database(path.join(root, ".aindrive", "willow.db"));
    const row = handle.prepare("SELECT seq FROM yjs_entries WHERE digest = 'dNew'").get();
    handle.close();
    // new entry must have seq 6 (localMax=5, nextSeq=6)
    expect(row.seq).toBe(6);
  });

  it("returns 0 for an empty entries array", () => {
    expect(applyGive(root, "doc1", [])).toBe(0);
  });
});
