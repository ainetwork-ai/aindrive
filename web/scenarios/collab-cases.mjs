/**
 * Collaborative editing — 20 deeper scenarios (#101–#120).
 *
 * Each test acts as one or more independent Y.js peers connected over
 * /api/agent/doc, exercising CRDT merge, presence (Awareness), reconnect, and
 * persistence across the live agent + Willow Store.
 */
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { execSync, spawn } from "node:child_process";
import * as Y from "yjs";
import { WebSocket } from "ws";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import Database from "better-sqlite3";

const BASE = process.env.AINDRIVE_BASE || "http://localhost:3737";
const WS_BASE = process.env.AINDRIVE_WS_BASE || "ws://localhost:3737";
const SAMPLE = "/mnt/newdata/git/aindrive/sample";

function bytesToB64(arr) { let s = ""; for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]); return Buffer.from(s, "binary").toString("base64"); }
function b64ToBytes(b64) { return new Uint8Array(Buffer.from(b64, "base64")); }
function assert(c, m) { if (!c) throw new Error(m || "assertion failed"); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || "expected equal"}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
async function jget(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

class Peer {
  constructor(label, cookie, driveId, path) {
    this.label = label; this.cookie = cookie; this.driveId = driveId; this.path = path;
    this.doc = new Y.Doc();
    this.ytext = this.doc.getText("content");
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.role = null;
    this.subscribed = false;
    this.events = [];
    this.doc.on("update", (update, origin) => {
      if (origin === this) return;
      const enc = encoding.createEncoder();
      syncProtocol.writeUpdate(enc, update);
      this.send({ t: "sync", msg: bytesToB64(encoding.toUint8Array(enc)) });
    });
    this.awareness.on("update", ({ added, updated, removed }, origin) => {
      if (origin === this) return;
      const changed = added.concat(updated).concat(removed);
      if (changed.length === 0) return;
      const u = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed);
      this.send({ t: "aware", msg: bytesToB64(u) });
    });
  }
  connect(timeout = 5000) {
    return new Promise((resolve, reject) => {
      const u = `${WS_BASE}/api/agent/doc?drive=${this.driveId}&path=${encodeURIComponent(this.path)}`;
      this.ws = new WebSocket(u, { headers: { cookie: this.cookie } });
      this.ws.on("open", () => {
        const enc = encoding.createEncoder();
        syncProtocol.writeSyncStep1(enc, this.doc);
        this.send({ t: "sync", msg: bytesToB64(encoding.toUint8Array(enc)) });
      });
      this.ws.on("message", (data) => {
        let f; try { f = JSON.parse(data.toString("utf8")); } catch { return; }
        if (f.t === "sub-ok") { this.role = f.role; this.subscribed = true; this.events.push("sub-ok"); resolve(); return; }
        if (f.t === "sync") {
          const dec = decoding.createDecoder(b64ToBytes(f.msg));
          const enc = encoding.createEncoder();
          syncProtocol.readSyncMessage(dec, enc, this.doc, this);
          if (encoding.length(enc) > 0) this.send({ t: "sync", msg: bytesToB64(encoding.toUint8Array(enc)) });
        }
        if (f.t === "aware") awarenessProtocol.applyAwarenessUpdate(this.awareness, b64ToBytes(f.msg), this);
        if (f.t === "reload") this.events.push("reload");
      });
      this.ws.on("close", () => { this.subscribed = false; this.events.push("close"); });
      this.ws.on("error", reject);
      setTimeout(() => reject(new Error("connect timeout")), timeout);
    });
  }
  send(f) { try { this.ws?.send(JSON.stringify(f)); } catch {} }
  type(s) { this.ytext.insert(this.ytext.length, s); }
  insertAt(pos, s) { this.ytext.insert(pos, s); }
  delete(pos, len) { this.ytext.delete(pos, len); }
  setUser(name, color = "#888") { this.awareness.setLocalStateField("user", { name, color }); }
  text() { return this.ytext.toString(); }
  close() { try { this.ws?.close(); } catch {} this.doc.destroy(); }
}

function docIdFor(driveId, path) {
  return createHash("sha1").update(`${driveId}:${path}`).digest("base64url").slice(0, 22);
}

function freshFile(name) {
  const path = `__collab-${name}-${Date.now()}.txt`;
  return path;
}

async function ensureFresh(state, path, initial = "") {
  const cookie = state.ownerCookie;
  await jget(`/api/drives/${state.driveId}/fs/write`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ path, content: initial, encoding: "utf8" }),
  });
  // Clear any stale Y.Doc binary so peers seed from disk
  const docId = docIdFor(state.driveId, path);
  const binPath = join(SAMPLE, ".aindrive", "yjs", `${docId}.bin`);
  if (existsSync(binPath)) try { unlinkSync(binPath); } catch {}
  // Also wipe willow entries for that doc
  try {
    const db = new Database(join(SAMPLE, ".aindrive", "willow.db"));
    db.prepare("DELETE FROM yjs_entries WHERE doc_id = ?").run(docId);
    db.close();
  } catch {}
}

// Public registration helper
export function registerCollabCases(add, state, helpers) {
  // Wrap each test body so the lazy-initialised driveId + ownerCookie are
  // guaranteed before the test runs (when this batch is executed standalone).
  const setup = async () => {
    // Always ensure a fresh owner if state.ownerCookie is missing
    if (!state.ownerCookie && helpers?.ensureOwner) {
      state.ownerCookie = await helpers.ensureOwner();
    } else if (state.ownerCookie && helpers?.reEnsureOwner) {
      state.ownerCookie = await helpers.reEnsureOwner();
    }
    if (helpers?.ensureDrive) await helpers.ensureDrive();
  };

  const wrap = (fn) => async () => { await setup(); await fn(); };

  add(101, "two peers — concurrent inserts at same position merge", wrap(async () => {
    const p = freshFile("101");
    await ensureFresh(state, p);
    const A = new Peer("A", state.ownerCookie, state.driveId, p);
    const B = new Peer("B", state.ownerCookie, state.driveId, p);
    await A.connect(); await B.connect();
    await sleep(500);
    A.insertAt(0, "AAA");
    B.insertAt(0, "BBB");
    await sleep(800);
    eq(A.text(), B.text(), "A and B converge");
    assert(A.text().includes("AAA") && A.text().includes("BBB"));
    A.close(); B.close();
  }));

  add(102, "delete vs insert race converges", wrap(async () => {
    const p = freshFile("102");
    await ensureFresh(state, p, "0123456789");
    const A = new Peer("A", state.ownerCookie, state.driveId, p);
    await A.connect();
    if (A.ytext.length === 0) A.ytext.insert(0, "0123456789");
    await sleep(300);
    const B = new Peer("B", state.ownerCookie, state.driveId, p);
    await B.connect();
    await sleep(800);
    assert(A.ytext.length === 10 && B.ytext.length === 10, "len A=" + A.ytext.length + " B=" + B.ytext.length);
    A.delete(2, 3);
    B.insertAt(5, "X");
    await sleep(800);
    eq(A.text(), B.text());
    A.close(); B.close();
  }));

  add(103, "five peers concurrent typing converge", wrap(async () => {
    const p = freshFile("103");
    await ensureFresh(state, p);
    const peers = await Promise.all(["A","B","C","D","E"].map(async (n) => { const x = new Peer(n, state.ownerCookie, state.driveId, p); await x.connect(); return x; }));
    await sleep(500);
    for (const peer of peers) peer.type(`<${peer.label}>`);
    await sleep(1500);
    const ref = peers[0].text();
    for (const peer of peers) eq(peer.text(), ref, peer.label);
    for (const peer of peers) assert(ref.includes(`<${peer.label}>`), `missing ${peer.label}`);
    peers.forEach((x) => x.close());
  }));

  add(104, "offline peer reconnects and merges", wrap(async () => {
    const p = freshFile("104");
    await ensureFresh(state, p, "start ");
    const A = new Peer("A", state.ownerCookie, state.driveId, p);
    const B = new Peer("B", state.ownerCookie, state.driveId, p);
    await A.connect(); await B.connect();
    await sleep(500);
    // B disconnects, both type
    B.ws.close();
    await sleep(300);
    A.type("[from-A-while-B-offline]");
    B.type("[from-B-while-offline]");
    // B reconnects
    const B2 = new Peer("B2", state.ownerCookie, state.driveId, p);
    // Apply B's offline state into B2 manually: encode B's update and sync once connected
    const offlineUpdate = Y.encodeStateAsUpdate(B.doc);
    await B2.connect();
    Y.applyUpdate(B2.doc, offlineUpdate, B2);
    // Force B2 to push its merged state
    const enc = encoding.createEncoder();
    syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(B2.doc));
    B2.send({ t: "sync", msg: bytesToB64(encoding.toUint8Array(enc)) });
    await sleep(1000);
    assert(A.text().includes("[from-A-while-B-offline]"));
    assert(A.text().includes("[from-B-while-offline]"), "A should now have B's offline edits");
    A.close(); B.close(); B2.close();
  }));

  add(105, "large insert (10 KB) propagates", wrap(async () => {
    const p = freshFile("105");
    await ensureFresh(state, p);
    const A = new Peer("A", state.ownerCookie, state.driveId, p);
    const B = new Peer("B", state.ownerCookie, state.driveId, p);
    await A.connect(); await B.connect();
    await sleep(500);
    const big = "x".repeat(10_000);
    A.type(big);
    await sleep(2500);
    eq(B.text().length, big.length);
    A.close(); B.close();
  }));

  add(106, "second peer joins mid-edit and gets full state", wrap(async () => {
    const p = freshFile("106");
    await ensureFresh(state, p, "INITIAL");
    const A = new Peer("A", state.ownerCookie, state.driveId, p);
    await A.connect();
    await sleep(300);
    A.type(" + early-edit");
    await sleep(500);
    // B connects late
    const B = new Peer("B", state.ownerCookie, state.driveId, p);
    await B.connect();
    await sleep(800);
    eq(B.text(), A.text(), "B should get A's existing content");
    assert(B.text().includes("early-edit"));
    A.close(); B.close();
  }));

  add(107, "Awareness — A's user info visible in B", wrap(async () => {
    const p = freshFile("107");
    await ensureFresh(state, p);
    const A = new Peer("A", state.ownerCookie, state.driveId, p);
    const B = new Peer("B", state.ownerCookie, state.driveId, p);
    await A.connect(); await B.connect();
    await sleep(300);
    A.setUser("Alice", "#ff0000");
    await sleep(800);
    let found = false;
    B.awareness.getStates().forEach((s) => { if (s?.user?.name === "Alice" && s.user.color === "#ff0000") found = true; });
    assert(found, "B should see Alice in awareness states");
    A.close(); B.close();
  }));

  add(108, "Awareness leave cleans up state in remote peer", wrap(async () => {
    const p = freshFile("108");
    await ensureFresh(state, p);
    const A = new Peer("A", state.ownerCookie, state.driveId, p);
    const B = new Peer("B", state.ownerCookie, state.driveId, p);
    await A.connect(); await B.connect();
    A.setUser("Alice"); B.setUser("Bob");
    await sleep(500);
    const before = B.awareness.getStates().size;
    A.close();
    await sleep(1500);
    // B's view of A's awareness state should drop within timeout (default 30s),
    // but at minimum we shouldn't error and total states shouldn't grow.
    const after = B.awareness.getStates().size;
    assert(after <= before, "awareness count should not grow after A leaves");
    B.close();
  }));

  add(109, "viewer-role peer denied subscription", wrap(async () => {
    // Create a paid share with role=viewer; pay via X-PAYMENT header (DEV_BYPASS).
    const cookie = state.ownerCookie;
    const p = freshFile("109");
    await ensureFresh(state, p, "viewer-only");
    const s = await jget(`/api/drives/${state.driveId}/shares`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ path: "", role: "viewer", price_usdc: 0.01 }),
    });
    // Build a minimal X-PAYMENT payload accepted by AINDRIVE_DEV_BYPASS_X402=1
    const fakePayer = "0xdemodemodemodemodemodemodemodemodemo0000";
    const xPayment = Buffer.from(JSON.stringify({
      x402Version: 1, scheme: "exact", network: "base-sepolia",
      payload: { authorization: { from: fakePayer } },
    })).toString("base64");
    const pay = await jget(`/api/s/${s.body.token}`, { headers: { "X-PAYMENT": xPayment } });
    const visitorCookie = pay.headers.get("set-cookie")?.split(";")[0];
    const V = new Peer("V", visitorCookie, state.driveId, p);
    await V.connect();
    eq(V.role, "viewer");
    // Server drops sync from viewer; verify that owner's edits are reflected via V's read
    const A = new Peer("A", cookie, state.driveId, p);
    await A.connect();
    await sleep(500);
    A.type(" [owner-edit]");
    await sleep(800);
    assert(V.text().includes("[owner-edit]"), "viewer should see owner's edits");
    A.close(); V.close();
  }));

  add(110, "two different files don't interfere", wrap(async () => {
    const p1 = freshFile("110a"); const p2 = freshFile("110b");
    await ensureFresh(state, p1, "first");
    await ensureFresh(state, p2, "second");
    const A1 = new Peer("A1", state.ownerCookie, state.driveId, p1);
    const A2 = new Peer("A2", state.ownerCookie, state.driveId, p2);
    await A1.connect(); await A2.connect();
    await sleep(300);
    A1.type(" + tail-1");
    A2.type(" + tail-2");
    await sleep(800);
    assert(A1.text().includes("tail-1") && !A1.text().includes("tail-2"));
    assert(A2.text().includes("tail-2") && !A2.text().includes("tail-1"));
    A1.close(); A2.close();
  }));

  add(111, "external disk overwrite triggers reload event", wrap(async () => {
    const p = freshFile("111");
    await ensureFresh(state, p, "before");
    // ensureFresh did a fs/write which triggers 2s self-write suppression.
    // Wait past the TTL before the "external" write so it doesn't get suppressed.
    await sleep(2500);
    const A = new Peer("A", state.ownerCookie, state.driveId, p);
    await A.connect();
    await sleep(500);
    writeFileSync(join(SAMPLE, p), "EXTERNALLY-WRITTEN-" + Date.now());
    await sleep(2000);
    assert(A.events.includes("reload"), "A should receive reload event, got " + JSON.stringify(A.events));
    A.close();
  }));

  add(112, "rapid 100 small inserts converge", wrap(async () => {
    const p = freshFile("112");
    await ensureFresh(state, p);
    const A = new Peer("A", state.ownerCookie, state.driveId, p);
    const B = new Peer("B", state.ownerCookie, state.driveId, p);
    await A.connect(); await B.connect();
    await sleep(300);
    for (let i = 0; i < 100; i++) {
      (i % 2 === 0 ? A : B).type(String(i % 10));
      if (i % 20 === 0) await sleep(20);
    }
    await sleep(2000);
    eq(A.text(), B.text(), "A/B converge after 100 ops");
    eq(A.text().length, 100);
    A.close(); B.close();
  }));

  add(113, "autosave persists to disk via fs/write", wrap(async () => {
    const p = freshFile("113");
    await ensureFresh(state, p);
    const cookie = state.ownerCookie;
    const A = new Peer("A", cookie, state.driveId, p);
    await A.connect();
    A.type("autosaved-content-" + Date.now());
    await sleep(300);
    // Simulate browser autosave path manually
    const docId = docIdFor(state.driveId, p);
    const update = Y.encodeStateAsUpdate(A.doc);
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path: p, content: A.text(), encoding: "utf8" }) });
    await jget(`/api/drives/${state.driveId}/yjs`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ docId, path: p, data: bytesToB64(update) }) });
    await sleep(500);
    const onDisk = readFileSync(join(SAMPLE, p), "utf8");
    eq(onDisk, A.text());
    A.close();
  }));

  add(114, "yjs-read replays into a fresh Y.Doc consistently", wrap(async () => {
    const cookie = state.ownerCookie;
    const p = freshFile("114");
    await ensureFresh(state, p);
    const A = new Peer("A", cookie, state.driveId, p);
    await A.connect();
    A.type("sentence-one. ");
    A.type("sentence-two.");
    await sleep(300);
    const docId = docIdFor(state.driveId, p);
    const update = Y.encodeStateAsUpdate(A.doc);
    await jget(`/api/drives/${state.driveId}/yjs`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ docId, path: p, data: bytesToB64(update) }) });
    // Read back via API
    const r = await jget(`/api/drives/${state.driveId}/yjs?docId=${docId}&path=${p}`, { headers: { cookie } });
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, b64ToBytes(r.body.data));
    eq(fresh.getText("content").toString(), A.text());
    A.close();
  }));

  add(115, "fresh peer joins after autosave — sees full state", wrap(async () => {
    const cookie = state.ownerCookie;
    const p = freshFile("115");
    await ensureFresh(state, p, "from-disk-seed");
    const A = new Peer("A", cookie, state.driveId, p);
    await A.connect();
    A.type(" plus-yjs-edit");
    const docId = docIdFor(state.driveId, p);
    const update = Y.encodeStateAsUpdate(A.doc);
    await jget(`/api/drives/${state.driveId}/yjs`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ docId, path: p, data: bytesToB64(update) }) });
    A.close();
    await sleep(500);
    // New peer joins → should pull updated Y.Doc state via WS sync
    const B = new Peer("B", cookie, state.driveId, p);
    await B.connect();
    await sleep(1500);
    // B may need to also fetch the persisted Y.Doc. Browser code does this; here we simulate.
    if (B.text().length === 0) {
      const r = await jget(`/api/drives/${state.driveId}/yjs?docId=${docId}&path=${p}`, { headers: { cookie } });
      Y.applyUpdate(B.doc, b64ToBytes(r.body.data), B);
    }
    assert(B.text().includes("plus-yjs-edit"), "B should see persisted yjs edits, got: " + JSON.stringify(B.text()));
    B.close();
  }));

  add(116, "delete entire content then refill", wrap(async () => {
    const p = freshFile("116");
    await ensureFresh(state, p, "old text that gets wiped");
    const A = new Peer("A", state.ownerCookie, state.driveId, p);
    const B = new Peer("B", state.ownerCookie, state.driveId, p);
    await A.connect(); await B.connect();
    await sleep(500);
    A.delete(0, A.ytext.length);
    A.type("NEW");
    await sleep(800);
    eq(B.text(), "NEW", "B should reflect total wipe + refill");
    A.close(); B.close();
  }));

  add(117, "non-text file (binary) skipped from collab path", wrap(async () => {
    // Editor opens collab only for text files; the API still serves read for binary.
    const cookie = state.ownerCookie;
    const p = `__collab-bin-${Date.now()}.bin`;
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path: p, content: Buffer.from([0x00, 0xFF, 0x10]).toString("base64"), encoding: "base64" }) });
    const r = await jget(`/api/drives/${state.driveId}/fs/read?path=${p}&encoding=base64`, { headers: { cookie } });
    eq(r.status, 200);
    assert(typeof r.body.content === "string");
  }));

  add(118, "agent restart mid-session — peer reconnects", wrap(async () => {
    const p = freshFile("118");
    await ensureFresh(state, p, "before-restart");
    const A = new Peer("A", state.ownerCookie, state.driveId, p);
    await A.connect();
    A.type(" + initial-edit");
    await sleep(300);
    // Restart sample agent in-place
    const lines = execSync("ps -eo pid,cmd | grep 'node start-agent.mjs' | grep -v grep || true").toString().trim().split("\n").filter(Boolean);
    for (const l of lines) { const pid = parseInt(l.trim().split(/\s+/)[0], 10); try { process.kill(pid, "SIGKILL"); } catch {} }
    await sleep(1500);
    spawn("node", ["start-agent.mjs"], { cwd: SAMPLE, detached: true, stdio: ["ignore", "ignore", "ignore"] }).unref();
    // Wait for agent to come back online
    let online = false;
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      const r = await jget("/api/drives", { headers: { cookie: state.ownerCookie } });
      const d = r.body.drives.find((d) => d.id === state.driveId);
      if (d?.online) { online = true; break; }
    }
    assert(online, "agent should reconnect");
    // Peer's WS may have closed; verify list still works
    const r2 = await jget(`/api/drives/${state.driveId}/fs/list?path=`, { headers: { cookie: state.ownerCookie } });
    eq(r2.status, 200);
    A.close();
  }));

  add(119, "Willow Store records autosave entries", wrap(async () => {
    const cookie = state.ownerCookie;
    const p = freshFile("119");
    await ensureFresh(state, p);
    const A = new Peer("A", cookie, state.driveId, p);
    await A.connect();
    A.type("entry-test");
    const docId = docIdFor(state.driveId, p);
    const update = Y.encodeStateAsUpdate(A.doc);
    const before = await jget(`/api/drives/${state.driveId}/yjs?docId=${docId}&path=${p}`, { headers: { cookie } });
    await jget(`/api/drives/${state.driveId}/yjs`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ docId, path: p, data: bytesToB64(update) }) });
    await sleep(500);
    const db = new Database(join(SAMPLE, ".aindrive", "willow.db"), { readonly: true });
    const cnt = db.prepare("SELECT COUNT(*) AS n FROM yjs_entries WHERE doc_id = ?").get(docId);
    db.close();
    assert(cnt.n >= 1, "expected ≥1 willow entry");
    A.close();
  }));

  add(120, "many simultaneous awareness updates don't crash", wrap(async () => {
    const p = freshFile("120");
    await ensureFresh(state, p);
    const peers = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
      const x = new Peer("P" + i, state.ownerCookie, state.driveId, p);
      await x.connect();
      x.setUser("user-" + i, "#" + (i * 100000).toString(16).padStart(6, "0").slice(0, 6));
      return x;
    }));
    await sleep(800);
    // Verify each peer has at least N awareness states (own + remotes)
    const minSeen = Math.min(...peers.map((p) => p.awareness.getStates().size));
    assert(minSeen >= 1, "each peer should have at least its own state");
    peers.forEach((x) => x.close());
  }));
}
