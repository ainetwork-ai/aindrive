// Characterization tests for attachSync() in willow-sync.js — agent-first
// migration safety net.
//
// These SNAPSHOT the *current* runtime behaviour of the WS sync wire protocol
// (NOT an assumed spec), so a later structural refactor can be proven
// behaviour-preserving. The 4 pure helpers (buildSummary / digestsWeMissFrom /
// fulfillWant / applyGive) are covered by willow-sync.test.mjs — this file
// covers the GAP: attachSync's ws message-handling/framing, the per-handler
// swallow-all try/catch, send's swallow-all, and the timer lifecycle.
//
// Every assertion below was verified by probing the real module before being
// locked here. Real better-sqlite3 + a fresh tmp root per test; a fake ws
// (EventEmitter with a capturing .send) drives real frames through the wire.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { attachSync } from "../willow-sync.js";

// Fresh tmp root with .aindrive/ (better-sqlite3 will not create the dir).
// buildSummary-equivalent bootstrap: open + CREATE TABLE IF NOT EXISTS so direct
// inserts below don't hit "no such table". attachSync's own db() helper re-runs
// the same CREATE TABLE, so this only mirrors what the module would do anyway.
function setupRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "attach-sync-char-"));
  mkdirSync(path.join(root, ".aindrive"), { recursive: true });
  const handle = new Database(path.join(root, ".aindrive", "willow.db"));
  handle.exec(`
    CREATE TABLE IF NOT EXISTS yjs_entries (
      doc_id TEXT NOT NULL, seq INTEGER NOT NULL,
      payload BLOB NOT NULL, digest TEXT NOT NULL,
      created_at INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'update',
      PRIMARY KEY (doc_id, seq)
    );
  `);
  handle.close();
  return root;
}

function insertEntry(root, { docId, seq, payload, digest, createdAt = Date.now(), kind = "update" }) {
  const handle = new Database(path.join(root, ".aindrive", "willow.db"));
  handle
    .prepare("INSERT INTO yjs_entries (doc_id, seq, payload, digest, created_at, kind) VALUES (?, ?, ?, ?, ?, ?)")
    .run(docId, seq, Buffer.from(payload), digest, createdAt, kind);
  handle.close();
}

function readRows(root) {
  const handle = new Database(path.join(root, ".aindrive", "willow.db"));
  const rows = handle.prepare("SELECT doc_id, seq, digest, created_at, kind, payload FROM yjs_entries ORDER BY doc_id, seq").all();
  handle.close();
  return rows;
}

// Fake ws: captures sent frames; inbound 'message'/'close' injected via emit.
class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
  }
  send(data) {
    this.sent.push(data);
  }
}

// Frames arrive as Buffers off the wire; attachSync does data.toString("utf8").
const frame = (obj) => Buffer.from(JSON.stringify(obj));
const parseSent = (ws) => ws.sent.map((s) => JSON.parse(s));

let root;
beforeEach(() => { root = setupRoot(); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("attachSync — sync-summary frame", () => {
  it("replies with a sync-want listing exactly the digests we are missing", () => {
    insertEntry(root, { docId: "doc1", seq: 1, payload: "a", digest: "d1" });
    const ws = new FakeWs();
    attachSync(ws, "drive", root);
    // peer claims d2 + d1; we only have d1 → want d2
    ws.emit("message", frame({ type: "sync-summary", docs: [{ docId: "doc1", lastSeq: 2, digests: ["d2", "d1"] }] }));
    expect(parseSent(ws)).toEqual([{ type: "sync-want", docId: "doc1", digests: ["d2"] }]);
  });

  it("sends nothing when we already have every digest the peer advertises", () => {
    insertEntry(root, { docId: "doc1", seq: 1, payload: "a", digest: "d1" });
    const ws = new FakeWs();
    attachSync(ws, "drive", root);
    ws.emit("message", frame({ type: "sync-summary", docs: [{ docId: "doc1", lastSeq: 1, digests: ["d1"] }] }));
    expect(ws.sent).toEqual([]);
  });

  it("emits one sync-want per doc that has missing digests", () => {
    const ws = new FakeWs();
    attachSync(ws, "drive", root);
    ws.emit("message", frame({
      type: "sync-summary",
      docs: [
        { docId: "docA", lastSeq: 1, digests: ["a1"] },
        { docId: "docB", lastSeq: 1, digests: ["b1"] },
      ],
    }));
    expect(parseSent(ws)).toEqual([
      { type: "sync-want", docId: "docA", digests: ["a1"] },
      { type: "sync-want", docId: "docB", digests: ["b1"] },
    ]);
  });
});

describe("attachSync — sync-want frame", () => {
  it("replies with a sync-give carrying the requested entries (payload base64)", () => {
    insertEntry(root, { docId: "doc1", seq: 1, payload: "hello", digest: "d1", createdAt: 222 });
    const ws = new FakeWs();
    attachSync(ws, "drive", root);
    ws.emit("message", frame({ type: "sync-want", docId: "doc1", digests: ["d1"] }));
    expect(parseSent(ws)).toEqual([
      {
        type: "sync-give",
        docId: "doc1",
        entries: [{ seq: 1, kind: "update", digest: "d1", created_at: 222, payload: Buffer.from("hello").toString("base64") }],
      },
    ]);
  });

  it("sends nothing when no local entry matches the requested digests", () => {
    insertEntry(root, { docId: "doc1", seq: 1, payload: "a", digest: "d1" });
    const ws = new FakeWs();
    attachSync(ws, "drive", root);
    ws.emit("message", frame({ type: "sync-want", docId: "doc1", digests: ["does-not-exist"] }));
    expect(ws.sent).toEqual([]);
  });
});

describe("attachSync — sync-give frame", () => {
  it("inserts the gifted entry into the DB (resequenced from local max) and sends nothing", () => {
    const ws = new FakeWs();
    attachSync(ws, "drive", root);
    const entries = [{ seq: 1, kind: "update", digest: "dG", created_at: 333, payload: Buffer.from("gift").toString("base64") }];
    ws.emit("message", frame({ type: "sync-give", docId: "doc1", entries }));
    expect(ws.sent).toEqual([]);
    const rows = readRows(root);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ doc_id: "doc1", seq: 1, digest: "dG", created_at: 333, kind: "update" });
    expect(Buffer.from(rows[0].payload).toString()).toBe("gift");
  });

  it("is idempotent by digest — a re-gift of the same digest inserts nothing new", () => {
    insertEntry(root, { docId: "doc1", seq: 5, payload: "existing", digest: "dE" });
    const ws = new FakeWs();
    attachSync(ws, "drive", root);
    const entries = [{ seq: 99, kind: "update", digest: "dE", created_at: 1, payload: Buffer.from("dup").toString("base64") }];
    ws.emit("message", frame({ type: "sync-give", docId: "doc1", entries }));
    const rows = readRows(root);
    expect(rows).toHaveLength(1);
    expect(rows[0].digest).toBe("dE");
    // original payload preserved (the dup was skipped, not overwritten)
    expect(Buffer.from(rows[0].payload).toString()).toBe("existing");
  });
});

describe("attachSync — parse guard & frame dispatch (no crash, no send)", () => {
  it("non-JSON frame early-returns: nothing sent, listener does not throw", () => {
    const ws = new FakeWs();
    attachSync(ws, "drive", root);
    expect(() => ws.emit("message", Buffer.from("not json {{{"))).not.toThrow();
    expect(ws.sent).toEqual([]);
  });

  it("valid JSON without a .type early-returns", () => {
    const ws = new FakeWs();
    attachSync(ws, "drive", root);
    ws.emit("message", frame({ foo: "bar" }));
    expect(ws.sent).toEqual([]);
  });

  it("JSON 'null' and a bare number are caught by the frame?.type guard (no crash)", () => {
    const ws = new FakeWs();
    attachSync(ws, "drive", root);
    expect(() => {
      ws.emit("message", Buffer.from("null"));
      ws.emit("message", Buffer.from("42"));
    }).not.toThrow();
    expect(ws.sent).toEqual([]);
  });

  it("an unknown frame type is ignored (no send)", () => {
    const ws = new FakeWs();
    attachSync(ws, "drive", root);
    ws.emit("message", frame({ type: "totally-unknown" }));
    expect(ws.sent).toEqual([]);
  });
});

describe("attachSync — swallow-all error handling", () => {
  // send() wraps ws.send in try{}catch{} (swallows), and each typed handler is
  // wrapped in try/catch that logs at warn and returns. Net effect: a throwing
  // socket or a structurally-malformed (but correctly-typed) frame never
  // propagates out of the message listener.
  it("send() swallows a throwing ws.send — sync-want handler does not throw out", () => {
    insertEntry(root, { docId: "doc1", seq: 1, payload: "a", digest: "d1" });
    const ws = new FakeWs();
    ws.send = () => { throw new Error("socket closed"); };
    attachSync(ws, "drive", root);
    expect(() => ws.emit("message", frame({ type: "sync-want", docId: "doc1", digests: ["d1"] }))).not.toThrow();
  });

  it("malformed sync-summary (missing docs) is swallowed by the handler try/catch", () => {
    const ws = new FakeWs();
    attachSync(ws, "drive", root);
    expect(() => ws.emit("message", frame({ type: "sync-summary" }))).not.toThrow();
    expect(ws.sent).toEqual([]);
  });

  it("malformed sync-want (missing digests) is swallowed by the handler try/catch", () => {
    const ws = new FakeWs();
    attachSync(ws, "drive", root);
    expect(() => ws.emit("message", frame({ type: "sync-want", docId: "doc1" }))).not.toThrow();
    expect(ws.sent).toEqual([]);
  });

  it("malformed sync-give (missing entries) is swallowed: nothing inserted, no throw", () => {
    const ws = new FakeWs();
    attachSync(ws, "drive", root);
    expect(() => ws.emit("message", frame({ type: "sync-give", docId: "doc1" }))).not.toThrow();
    expect(ws.sent).toEqual([]);
    expect(readRows(root)).toEqual([]);
  });
});

describe("attachSync — summary timer lifecycle", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("does NOT broadcast immediately on attach (initial summary is deferred ~1s)", () => {
    insertEntry(root, { docId: "doc1", seq: 1, payload: "a", digest: "d1" });
    const ws = new FakeWs();
    attachSync(ws, "drive", root);
    expect(ws.sent).toEqual([]);
  });

  it("broadcasts the initial summary ~1s after attach when the DB is non-empty", () => {
    insertEntry(root, { docId: "doc1", seq: 1, payload: "a", digest: "d1" });
    const ws = new FakeWs();
    attachSync(ws, "drive", root);
    vi.advanceTimersByTime(1000);
    expect(parseSent(ws)).toEqual([
      { type: "sync-summary", docs: [{ docId: "doc1", lastSeq: 1, digests: ["d1"] }] },
    ]);
  });

  it("sends nothing on the initial timer when the DB is empty (docs.length > 0 guard)", () => {
    const ws = new FakeWs();
    attachSync(ws, "drive", root);
    vi.advanceTimersByTime(1000);
    expect(ws.sent).toEqual([]);
  });

  it("re-broadcasts the summary every 30s via setInterval", () => {
    insertEntry(root, { docId: "doc1", seq: 1, payload: "a", digest: "d1" });
    const ws = new FakeWs();
    attachSync(ws, "drive", root);
    vi.advanceTimersByTime(1000);   // initial
    vi.advanceTimersByTime(30_000); // first interval tick
    vi.advanceTimersByTime(30_000); // second interval tick
    expect(ws.sent).toHaveLength(3);
    expect(parseSent(ws).every((f) => f.type === "sync-summary")).toBe(true);
  });

  it("'close' clears the interval — no further summaries fire afterwards", () => {
    insertEntry(root, { docId: "doc1", seq: 1, payload: "a", digest: "d1" });
    const ws = new FakeWs();
    attachSync(ws, "drive", root);
    vi.advanceTimersByTime(1000); // initial summary lands
    expect(ws.sent).toHaveLength(1);
    ws.emit("close");
    vi.advanceTimersByTime(120_000); // four interval periods worth of time
    expect(ws.sent).toHaveLength(1); // nothing more after close
  });
});
