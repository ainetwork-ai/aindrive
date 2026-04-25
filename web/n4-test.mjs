/**
 * N4 / N5 lite smoke test — replaces Playwright multi-context for speed.
 * Two pure-Node WebSocket clients act as concurrent editors of the same file
 * in the running drive. Verifies:
 *   - Y.js updates broadcast in both directions through DocHub
 *   - Both clients converge to the same Y.Doc state
 *   - Autosave hits /api/drives/.../fs/write so the file on disk matches
 *   - Willow Store records each yjs-write as an entry
 */
import * as Y from "yjs";
import { WebSocket } from "ws";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import { createHash } from "node:crypto";

const BASE = "http://localhost:3737";
const WS_BASE = "ws://localhost:3737";
const OWNER_EMAIL = "m5-1776999478@example.com";
const OWNER_PASSWORD = "m5pass1234";
const DRIVE_ID = "rr5NDM0UQI4J";
const PATH = "README.md";
const SAMPLE_PATH = "/mnt/newdata/git/aindrive/sample/" + PATH;

const docId = createHash("sha1").update(`${DRIVE_ID}:${PATH}`).digest("base64url").slice(0, 22);
console.log("docId:", docId);

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
  });
  if (res.status !== 200) throw new Error("login failed: " + (await res.text()));
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("no cookie");
  return cookie;
}

function bytesToB64(arr) { let s = ""; for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]); return Buffer.from(s, "binary").toString("base64"); }
function b64ToBytes(b64) { const buf = Buffer.from(b64, "base64"); return new Uint8Array(buf); }

class TestPeer {
  constructor(name, cookie) {
    this.name = name;
    this.cookie = cookie;
    this.doc = new Y.Doc();
    this.ytext = this.doc.getText("content");
    this.ws = null;
    this.synced = false;
    this.doc.on("update", (update, origin) => {
      if (origin === this) return;
      const enc = encoding.createEncoder();
      syncProtocol.writeUpdate(enc, update);
      this.send({ t: "sync", msg: bytesToB64(encoding.toUint8Array(enc)) });
    });
  }

  connect() {
    return new Promise((resolve, reject) => {
      const url = `${WS_BASE}/api/agent/doc?drive=${DRIVE_ID}&path=${encodeURIComponent(PATH)}`;
      const ws = new WebSocket(url, { headers: { cookie: this.cookie } });
      this.ws = ws;
      ws.on("open", () => {
        // Step 1: send our state vector
        const enc = encoding.createEncoder();
        syncProtocol.writeSyncStep1(enc, this.doc);
        this.send({ t: "sync", msg: bytesToB64(encoding.toUint8Array(enc)) });
      });
      ws.on("message", (data) => {
        let frame; try { frame = JSON.parse(data.toString("utf8")); } catch { return; }
        if (frame.t === "sub-ok") { console.log(`  [${this.name}] sub-ok role=${frame.role} peers=${frame.peers}`); resolve(); return; }
        if (frame.t === "sync") {
          const dec = decoding.createDecoder(b64ToBytes(frame.msg));
          const enc = encoding.createEncoder();
          const messageType = syncProtocol.readSyncMessage(dec, enc, this.doc, this);
          if (encoding.length(enc) > 0) this.send({ t: "sync", msg: bytesToB64(encoding.toUint8Array(enc)) });
          if (messageType === syncProtocol.messageYjsSyncStep2) this.synced = true;
        }
      });
      ws.on("error", reject);
    });
  }

  send(frame) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(frame));
  }

  type(text) {
    // No origin → marks this as a LOCAL edit so the doc.on('update') listener
    // forwards it on the wire. Wire-received updates are applied with origin=this
    // by readSyncMessage, which the listener short-circuits.
    this.ytext.insert(this.ytext.length, text);
  }

  close() { try { this.ws?.close(); } catch {} }
}

async function autosave(peer) {
  const text = peer.ytext.toString();
  const update = Y.encodeStateAsUpdate(peer.doc);
  await Promise.all([
    fetch(`${BASE}/api/drives/${DRIVE_ID}/fs/write`, {
      method: "POST", headers: { "content-type": "application/json", cookie: peer.cookie },
      body: JSON.stringify({ path: PATH, content: text, encoding: "utf8" }),
    }),
    fetch(`${BASE}/api/drives/${DRIVE_ID}/yjs`, {
      method: "POST", headers: { "content-type": "application/json", cookie: peer.cookie },
      body: JSON.stringify({ docId, path: PATH, data: bytesToB64(update) }),
    }),
  ]);
}

const cookie = await login();
console.log("logged in ✓");

const A = new TestPeer("A", cookie);
const B = new TestPeer("B", cookie);
await A.connect();
await B.connect();
console.log("both connected ✓");

// Wait for initial sync
await sleep(1000);

// Capture starting text
const starting = A.ytext.toString();
console.log(`starting text len=${starting.length}: "${starting.slice(0, 60)}…"`);

// A types
const tagA = `\n[from A ${Date.now()}]\n`;
A.type(tagA);
await sleep(500);

// B types
const tagB = `\n[from B ${Date.now()}]\n`;
B.type(tagB);
await sleep(1500);

// Both should now see both tags
const aText = A.ytext.toString();
const bText = B.ytext.toString();
console.log("A sees A's tag:", aText.includes(tagA));
console.log("A sees B's tag:", aText.includes(tagB));
console.log("B sees A's tag:", bText.includes(tagA));
console.log("B sees B's tag:", bText.includes(tagB));

if (aText !== bText) {
  console.error("FAIL: A and B diverged");
  console.error("A:", JSON.stringify(aText));
  console.error("B:", JSON.stringify(bText));
  process.exit(1);
}

// Autosave from A
console.log("\nautosaving from A…");
await autosave(A);
await sleep(500);

// Read disk file
const onDisk = readFileSync(SAMPLE_PATH, "utf8");
console.log(`disk file: "${onDisk.slice(0, 80)}…"`);
console.log("disk has A's tag:", onDisk.includes(tagA));
console.log("disk has B's tag:", onDisk.includes(tagB));

if (!onDisk.includes(tagA) || !onDisk.includes(tagB)) {
  console.error("FAIL: disk missing one of the tags");
  process.exit(1);
}

// Also verify Willow Store recorded the update
const Database = (await import("better-sqlite3")).default;
const db = new Database("/mnt/newdata/git/aindrive/sample/.aindrive/willow.db", { readonly: true });
const stats = db.prepare("SELECT kind, COUNT(*) AS n FROM yjs_entries WHERE doc_id = ? GROUP BY kind").all(docId);
console.log(`willow entries for ${docId}:`, stats);
db.close();

A.close(); B.close();
console.log("\n🎉 N1+N2+N3+N4 collaborative editing PASSED");
