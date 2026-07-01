// Characterization tests for willow-store.js — agent-first migration safety net.
//
// These SNAPSHOT the *current* behaviour of the module (not an assumed spec) so
// the later structural refactor can be proven behaviour-preserving. Reads are
// served entirely by the `yjs_entries` SQLite mirror; the official Willow Store
// write is fire-and-forget (see the "Store" describe block + PRODUCTION_TODO
// "Known bugs"). Each test uses a fresh tmp root because willow-store caches one
// DB + Store handle per root.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import * as Y from "yjs";

import {
  appendUpdate,
  listEntries,
  compactToSnapshot,
  statsForDoc,
  listDocs,
  maybeCompact,
} from "../willow-store.js";

const sha256url = (bytes) => createHash("sha256").update(bytes).digest("base64url");

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "willow-store-char-"));
});

describe("appendUpdate", () => {
  it("assigns monotonic per-doc seq starting at 1 and returns { seq, digest }", () => {
    expect(appendUpdate(root, "doc", new Uint8Array([1]))).toEqual({ seq: 1, digest: sha256url(new Uint8Array([1])) });
    expect(appendUpdate(root, "doc", new Uint8Array([2])).seq).toBe(2);
    expect(appendUpdate(root, "doc", new Uint8Array([3])).seq).toBe(3);
    // seq is per-doc, not global
    expect(appendUpdate(root, "other", new Uint8Array([9])).seq).toBe(1);
  });

  it("digest is sha256(payload) base64url; identical bytes → identical digest", () => {
    const a = appendUpdate(root, "doc", new Uint8Array([7, 7, 7]));
    const b = appendUpdate(root, "doc", new Uint8Array([7, 7, 7]));
    expect(a.digest).toBe(sha256url(new Uint8Array([7, 7, 7])));
    expect(a.digest).toBe(b.digest);
  });

  it("accepts a Buffer and a Uint8Array interchangeably (same digest)", () => {
    const u = appendUpdate(root, "doc", new Uint8Array([4, 2]));
    const b = appendUpdate(root, "doc", Buffer.from([4, 2]));
    expect(b.digest).toBe(u.digest);
  });

  it("defaults kind to 'update'", () => {
    appendUpdate(root, "doc", new Uint8Array([1]));
    expect(listEntries(root, "doc")[0].kind).toBe("update");
  });
});

describe("listEntries", () => {
  it("returns [] for an unknown doc", () => {
    expect(listEntries(root, "nope")).toEqual([]);
  });

  it("returns rows oldest-first with the v1 shape", () => {
    appendUpdate(root, "doc", new Uint8Array([1, 1]));
    appendUpdate(root, "doc", new Uint8Array([2, 2, 2]));
    const rows = listEntries(root, "doc");
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    const r0 = rows[0];
    expect(Object.keys(r0).sort()).toEqual(["created_at", "digest", "kind", "payload", "seq"]);
    expect(Buffer.isBuffer(r0.payload)).toBe(true);
    expect([...r0.payload]).toEqual([1, 1]);
    expect(typeof r0.created_at).toBe("number");
  });

  it("windows from the latest snapshot (inclusive) — older updates are not returned", () => {
    appendUpdate(root, "doc", new Uint8Array([1]));
    appendUpdate(root, "doc", new Uint8Array([2]));
    appendUpdate(root, "doc", new Uint8Array([3]));   // seq 1,2,3
    compactToSnapshot(root, "doc", new Uint8Array([9])); // snapshot seq 4, deletes <4
    appendUpdate(root, "doc", new Uint8Array([5]));   // seq 5
    const rows = listEntries(root, "doc");
    expect(rows.map((r) => ({ seq: r.seq, kind: r.kind }))).toEqual([
      { seq: 4, kind: "snapshot" },
      { seq: 5, kind: "update" },
    ]);
  });
});

describe("compactToSnapshot", () => {
  it("writes a snapshot at maxSeq+1 and deletes every older entry", () => {
    appendUpdate(root, "doc", new Uint8Array([1]));
    appendUpdate(root, "doc", new Uint8Array([2]));
    const snap = new Uint8Array([8, 8]);
    const res = compactToSnapshot(root, "doc", snap);
    expect(res).toEqual({ seq: 3, digest: sha256url(snap) });
    const rows = listEntries(root, "doc");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seq: 3, kind: "snapshot" });
    expect([...rows[0].payload]).toEqual([8, 8]);
  });
});

describe("statsForDoc", () => {
  it("returns the SQL null contract for an empty doc (count 0, others null)", () => {
    expect(statsForDoc(root, "empty")).toEqual({
      count: 0, bytes: null, last_seq: null, last_at: null,
    });
  });

  it("aggregates count / total payload bytes / max seq for a populated doc", () => {
    appendUpdate(root, "doc", new Uint8Array([1, 1]));      // 2 bytes
    appendUpdate(root, "doc", new Uint8Array([2, 2, 2]));   // 3 bytes
    const s = statsForDoc(root, "doc");
    expect(s.count).toBe(2);
    expect(s.bytes).toBe(5);
    expect(s.last_seq).toBe(2);
    expect(typeof s.last_at).toBe("number");
  });
});

describe("listDocs", () => {
  it("groups entry counts by doc_id", () => {
    appendUpdate(root, "a", new Uint8Array([1]));
    appendUpdate(root, "a", new Uint8Array([2]));
    appendUpdate(root, "b", new Uint8Array([3]));
    const docs = listDocs(root).sort((x, y) => x.doc_id.localeCompare(y.doc_id));
    expect(docs).toEqual([
      { doc_id: "a", entries: 2 },
      { doc_id: "b", entries: 1 },
    ]);
  });
});

describe("maybeCompact", () => {
  it("is a no-op below all thresholds (no snapshot is created)", async () => {
    for (let i = 0; i < 3; i++) appendUpdate(root, "doc", new Uint8Array([i]));
    await maybeCompact(root, "doc");
    const rows = listEntries(root, "doc");
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.kind === "update")).toBe(true);
  });

  it("compacts to a single snapshot once the update-count threshold (50) is hit", async () => {
    for (let i = 0; i < 50; i++) appendUpdate(root, "doc", new Uint8Array([i & 0xff]));
    await maybeCompact(root, "doc");
    const rows = listEntries(root, "doc");
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("snapshot");
  });

  it("compaction replays real Y.js updates faithfully into the snapshot", async () => {
    // Drive a real Y.Doc, append each incremental update, force compaction,
    // then confirm the snapshot replays to the same state — locks the replay path.
    const doc = new Y.Doc();
    const arr = doc.getArray("items");
    for (let i = 0; i < 50; i++) {
      let update;
      doc.once("update", (u) => { update = u; });
      arr.push([i]);
      appendUpdate(root, "ydoc", update);
    }
    await maybeCompact(root, "ydoc");
    const rows = listEntries(root, "ydoc");
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("snapshot");
    const replay = new Y.Doc();
    Y.applyUpdate(replay, new Uint8Array(rows[0].payload));
    expect(replay.getArray("items").toArray()).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });
});

describe("Willow Store write (fire-and-forget) — mirror stays authoritative", () => {
  // Documents the verified runtime reality: the official Store write does NOT
  // throw/reject (an earlier audit wrongly predicted ERR_PACKAGE_PATH_NOT_EXPORTED),
  // and reads are served from the mirror regardless. See PRODUCTION_TODO "Known bugs".
  it("appendUpdate returns the mirror result synchronously without a Store error", async () => {
    const warns = [];
    const orig = console.warn;
    console.warn = (...a) => warns.push(a.join(" "));
    try {
      const res = appendUpdate(root, "doc", new Uint8Array([1, 2, 3]));
      expect(res.seq).toBe(1); // returned before the async Store write settles
      await new Promise((r) => setTimeout(r, 50)); // let the fire-and-forget .catch run
    } finally {
      console.warn = orig;
    }
    expect(warns.filter((w) => w.includes("[willow] store.set"))).toEqual([]);
  });
});
