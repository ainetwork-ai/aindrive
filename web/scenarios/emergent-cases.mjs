/**
 * Emergent / steady-state scenarios (#141–#160).
 *
 * Reflection: prior tests verified that EVENTS HAPPEN; they didn't verify what
 * HAPPENS WHEN NOTHING SHOULD. Bugs like the autosave→fs.watch→reload loop are
 * emergent — each piece is correct in isolation; their interaction over time
 * is what fails. These tests assert ABSENCE, RATE, COUNT, and STEADY STATE.
 */
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { join } from "node:path";
import * as Y from "yjs";
import { WebSocket } from "ws";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";

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

function docIdFor(driveId, path) {
  return createHash("sha1").update(`${driveId}:${path}`).digest("base64url").slice(0, 22);
}
function cliDocIdFor(path) {
  return createHash("sha1").update(path).digest("base64url").slice(0, 22);
}

async function fetchTraces({ docId, since, limit = 1000 } = {}) {
  const params = new URLSearchParams();
  if (docId) params.set("docId", docId);
  if (since) params.set("since", String(since));
  if (limit) params.set("limit", String(limit));
  const r = await jget(`/api/dev/trace/dump?${params}`);
  return r.body.events || [];
}

async function pushTrace(events) {
  return jget("/api/dev/trace", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(events),
  });
}

function runDiagnose(events) {
  const tmp = `/tmp/diag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jsonl`;
  writeFileSync(tmp, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  let out = "";
  try { out = execSync(`node /mnt/newdata/git/aindrive/tools/diagnose.mjs ${tmp}`, { encoding: "utf8" }); }
  catch (e) { out = (e.stdout || "") + (e.stderr || ""); }
  finally { try { unlinkSync(tmp); } catch {} }
  return out;
}

class Peer {
  constructor(label, cookie, driveId, path) {
    this.label = label; this.cookie = cookie; this.driveId = driveId; this.path = path;
    this.doc = new Y.Doc();
    this.ytext = this.doc.getText("content");
    this.role = null;
    this.events = [];
    this.doc.on("update", (update, origin) => {
      if (origin === this) return;
      const enc = encoding.createEncoder();
      syncProtocol.writeUpdate(enc, update);
      this.send({ t: "sync", msg: bytesToB64(encoding.toUint8Array(enc)) });
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
        this.events.push(f.t || f.type || "?");
        if (f.t === "sub-ok") { this.role = f.role; resolve(); return; }
        if (f.t === "sync") {
          const dec = decoding.createDecoder(b64ToBytes(f.msg));
          const enc = encoding.createEncoder();
          syncProtocol.readSyncMessage(dec, enc, this.doc, this);
          if (encoding.length(enc) > 0) this.send({ t: "sync", msg: bytesToB64(encoding.toUint8Array(enc)) });
        }
      });
      this.ws.on("error", reject);
      setTimeout(() => reject(new Error("connect timeout")), timeout);
    });
  }
  send(f) { try { this.ws?.send(JSON.stringify(f)); } catch {} }
  type(s) { this.ytext.insert(this.ytext.length, s); }
  text() { return this.ytext.toString(); }
  close() { try { this.ws?.close(); } catch {} this.doc.destroy(); }
  reloadCount() { return this.events.filter((e) => e === "reload").length; }
}

export function registerEmergentCases(add, state, helpers) {
  const setup = async () => {
    if (!state.ownerCookie && helpers?.ensureOwner) state.ownerCookie = await helpers.ensureOwner();
    else if (state.ownerCookie && helpers?.reEnsureOwner) state.ownerCookie = await helpers.reEnsureOwner();
    if (helpers?.ensureDrive) await helpers.ensureDrive();
  };
  const t = (n, name, body) => add(n, name, async () => { await setup(); await body(); });

  // ──── Steady-state / no-oscillation (141–145) ────

  t(141, "after fs/write API call: NO reload-event broadcast within 3s", async () => {
    const cookie = state.ownerCookie;
    const path = "emerg-141-" + Date.now() + ".txt";
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: "init", encoding: "utf8" }) });
    await sleep(500);
    const docId = docIdFor(state.driveId, path);
    const peer = new Peer("P", cookie, state.driveId, path);
    await peer.connect();
    await sleep(300);
    peer.events.length = 0;
    const since = Date.now();
    // Now write to disk via API and watch — NO reload should fire (suppressed by self-write)
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: "self-write", encoding: "utf8" }) });
    await sleep(2000);
    eq(peer.reloadCount(), 0, "self-write must not trigger reload (events: " + JSON.stringify(peer.events) + ")");
    peer.close();
    void docId; void since;
  });

  t(142, "external disk write DOES trigger reload-event", async () => {
    const cookie = state.ownerCookie;
    const path = "emerg-142-" + Date.now() + ".txt";
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: "init", encoding: "utf8" }) });
    // Wait past self-write TTL (2s) before doing the "external" edit
    await sleep(2500);
    const peer = new Peer("P", cookie, state.driveId, path);
    await peer.connect();
    await sleep(500);
    peer.events.length = 0;
    writeFileSync(join(SAMPLE, path), "EXTERNALLY-EDITED-" + Date.now());
    await sleep(2000);
    assert(peer.reloadCount() >= 1, "external edit must trigger reload, events=" + JSON.stringify(peer.events));
    peer.close();
  });

  t(143, "fs-changed-suppressed trace fires for self-write paths", async () => {
    const cookie = state.ownerCookie;
    const path = "emerg-143-" + Date.now() + ".txt";
    const since = Date.now();
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: "x", encoding: "utf8" }) });
    await sleep(1500);
    const events = await fetchTraces({ since, limit: 200 });
    const suppressed = events.filter((e) => e.event === "fs-changed-suppressed" && e.extra?.path === path);
    assert(suppressed.length >= 1, "expected fs-changed-suppressed for self-write");
  });

  t(144, "external write produces fs-changed (NOT suppressed)", async () => {
    const path = "emerg-144-" + Date.now() + ".txt";
    const since = Date.now();
    writeFileSync(join(SAMPLE, path), "outside-" + Date.now());
    await sleep(1500);
    const events = await fetchTraces({ since, limit: 200 });
    const fired = events.filter((e) => e.event === "fs-changed" && e.extra?.path === path);
    assert(fired.length >= 1, "expected fs-changed for external write");
  });

  t(145, "idle peer (no input) emits zero ydoc-update events over 3s", async () => {
    const cookie = state.ownerCookie;
    const path = "emerg-145-" + Date.now() + ".txt";
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: "idle", encoding: "utf8" }) });
    const docId = docIdFor(state.driveId, path);
    const peer = new Peer("P", cookie, state.driveId, path);
    await peer.connect();
    await sleep(500);
    const since = Date.now();
    await sleep(3000);
    const events = await fetchTraces({ docId, since });
    const updates = events.filter((e) => e.event === "ydoc-update");
    assert(updates.length === 0, `idle peer should emit 0 updates, got ${updates.length}`);
    peer.close();
  });

  // ──── Self-write isolation (146–150) ────

  t(146, "self-write suppression returns true immediately after write", async () => {
    const { isSelfWrite } = await import("/mnt/newdata/git/aindrive/cli/src/rpc.js");
    // Trigger a write via API
    const cookie = state.ownerCookie;
    const path = "emerg-146-" + Date.now() + ".txt";
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: "x", encoding: "utf8" }) });
    // isSelfWrite is checked inside the agent process — we can't query it from here directly.
    // Instead verify via trace: a fs-changed-suppressed must appear for that path.
    await sleep(1200);
    const events = await fetchTraces({ since: Date.now() - 3000, limit: 500 });
    assert(events.some((e) => e.event === "fs-changed-suppressed" && e.extra?.path === path), "expected suppression trace");
    void isSelfWrite;
  });

  t(147, "self-write suppression expires within ~3s", async () => {
    const cookie = state.ownerCookie;
    const path = "emerg-147-" + Date.now() + ".txt";
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: "init", encoding: "utf8" }) });
    await sleep(3500);
    const since = Date.now();
    // After TTL, an external write to same path should produce fs-changed (NOT suppressed)
    writeFileSync(join(SAMPLE, path), "post-ttl-" + Date.now());
    await sleep(1500);
    const events = await fetchTraces({ since, limit: 100 });
    const fired = events.filter((e) => e.event === "fs-changed" && e.extra?.path === path);
    assert(fired.length >= 1, "after TTL, external write should produce fs-changed, got events=" + JSON.stringify(events.map((e) => e.event)));
  });

  t(148, "two consecutive API writes both get suppressed", async () => {
    const cookie = state.ownerCookie;
    const path = "emerg-148-" + Date.now() + ".txt";
    const since = Date.now();
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: "v1", encoding: "utf8" }) });
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: "v2", encoding: "utf8" }) });
    await sleep(1500);
    const events = await fetchTraces({ since, limit: 200 });
    const suppressed = events.filter((e) => e.event === "fs-changed-suppressed" && e.extra?.path === path);
    const fired = events.filter((e) => e.event === "fs-changed" && e.extra?.path === path);
    assert(suppressed.length >= 1, "expected suppression");
    eq(fired.length, 0, "no unsuppressed fs-changed should fire for self-writes");
  });

  t(149, "yjs-write does NOT trigger fs.watch on the user's source file", async () => {
    const cookie = state.ownerCookie;
    const path = "emerg-149-" + Date.now() + ".txt";
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: "x", encoding: "utf8" }) });
    const docId = docIdFor(state.driveId, path);
    await sleep(1500);
    const since = Date.now();
    // yjs-write writes to .aindrive/yjs/<docId>.bin (which is hidden from fs.watch by HIDDEN set)
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "yjs-data");
    const update = Y.encodeStateAsUpdate(doc);
    await jget(`/api/drives/${state.driveId}/yjs`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ docId, path, data: bytesToB64(update) }) });
    await sleep(1500);
    const events = await fetchTraces({ since, limit: 200 });
    const reloads = events.filter((e) => e.event === "fs-changed" && e.extra?.path?.startsWith(".aindrive"));
    eq(reloads.length, 0, "yjs-write to .aindrive/yjs must not produce visible fs-changed");
  });

  t(150, "trace count after one user keystroke + autosave bounded", async () => {
    const cookie = state.ownerCookie;
    const path = "emerg-150-" + Date.now() + ".txt";
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: "", encoding: "utf8" }) });
    const docId = docIdFor(state.driveId, path);
    const since = Date.now();
    const A = new Peer("A", cookie, state.driveId, path);
    await A.connect();
    A.type("keystroke");
    // Simulate autosave path
    const update = Y.encodeStateAsUpdate(A.doc);
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: A.text(), encoding: "utf8" }) });
    await jget(`/api/drives/${state.driveId}/yjs`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ docId, path, data: bytesToB64(update) }) });
    await sleep(3000);
    const events = await fetchTraces({ docId, since, limit: 1000 });
    // Bound: should be < 30 events for one keystroke (no infinite loop)
    assert(events.length < 30, `event count should be <30, got ${events.length}: ` + JSON.stringify(events.map((e) => e.event)));
    A.close();
  });

  // ──── Loop / oscillation detection (151–155) ────

  t(151, "diagnose flags V9 autosave-induced-reload-loop", async () => {
    const out = runDiagnose([
      { t: 1000, docId: "x151", src: "browser", session: "S1", event: "provider-connect" },
      { t: 1100, docId: "x151", src: "browser", session: "S1", event: "provider-sub-ok", extra: { role: "owner", peers: 1 } },
      { t: 5000, docId: "x151", src: "browser", session: "S1", event: "autosave-flush" },
      { t: 5300, docId: "x151", src: "browser", session: "S1", event: "reload-event" },
    ]);
    assert(/V9 autosave-induced-reload-loop/.test(out), "expected V9, got:\n" + out);
  });

  t(152, "diagnose flags V10 reload-echo-no-op", async () => {
    const out = runDiagnose([
      { t: 1000, docId: "x152", src: "browser", session: "S1", event: "provider-connect" },
      { t: 1100, docId: "x152", src: "browser", session: "S1", event: "provider-sub-ok", extra: { role: "owner", peers: 1 } },
      { t: 2000, docId: "x152", src: "browser", session: "S1", event: "ydoc-update", origin: "local", textLen: 10, byteLen: 15 },
      { t: 7000, docId: "x152", src: "browser", session: "S1", event: "reload-event" },
      { t: 7100, docId: "x152", src: "browser", session: "S1", event: "ydoc-update", origin: "remote", textLen: 10, byteLen: 15 },
    ]);
    assert(/V10 reload-echo-no-op/.test(out), "expected V10, got:\n" + out);
  });

  t(153, "live: 10s of one-time edit produces ZERO loop violations", async () => {
    const cookie = state.ownerCookie;
    const path = "emerg-153-" + Date.now() + ".txt";
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: "", encoding: "utf8" }) });
    const docId = docIdFor(state.driveId, path);
    const A = new Peer("A", cookie, state.driveId, path);
    await A.connect();
    A.type("hello");
    const update = Y.encodeStateAsUpdate(A.doc);
    const since = Date.now();
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: A.text(), encoding: "utf8" }) });
    await jget(`/api/drives/${state.driveId}/yjs`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ docId, path, data: bytesToB64(update) }) });
    await sleep(10_000);
    const events = await fetchTraces({ docId, since, limit: 1000 });
    // Synthesize a server-side autosave-flush event for the diagnose check (browser would emit this)
    const synthetic = [
      { t: since,        docId, src: "browser", session: "S153", event: "provider-connect" },
      { t: since + 10,   docId, src: "browser", session: "S153", event: "provider-sub-ok", extra: { role: "owner", peers: 1 } },
      { t: since + 50,   docId, src: "browser", session: "S153", event: "autosave-flush" },
      ...events.filter((e) => e.event === "ws-doc-fwd" || e.event === "ws-doc-sub"),
    ];
    const out = runDiagnose(synthetic);
    assert(!/V9 autosave-induced-reload-loop/.test(out), "loop detected in live session: " + out);
  });

  t(154, "live: after 1 keystroke, NO autosave-flush should be followed by reload within 1s", async () => {
    const cookie = state.ownerCookie;
    const path = "emerg-154-" + Date.now() + ".txt";
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: "", encoding: "utf8" }) });
    const docId = docIdFor(state.driveId, path);
    const A = new Peer("A", cookie, state.driveId, path);
    await A.connect();
    A.type("once");
    const update = Y.encodeStateAsUpdate(A.doc);
    const since = Date.now();
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: A.text(), encoding: "utf8" }) });
    await jget(`/api/drives/${state.driveId}/yjs`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ docId, path, data: bytesToB64(update) }) });
    await sleep(3000);
    // Did the peer receive a reload?
    eq(A.reloadCount(), 0, "after our own write, peer must not receive reload, events=" + JSON.stringify(A.events));
    A.close();
    void since;
  });

  t(155, "live: idle 5s after autosave produces no further server-side ws-doc-fwd", async () => {
    const cookie = state.ownerCookie;
    const path = "emerg-155-" + Date.now() + ".txt";
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: "x", encoding: "utf8" }) });
    const docId = docIdFor(state.driveId, path);
    const A = new Peer("A", cookie, state.driveId, path);
    await A.connect();
    A.type("once");
    await sleep(800);
    const since = Date.now();
    await sleep(5000);
    const events = await fetchTraces({ docId, since, limit: 500 });
    const fwds = events.filter((e) => e.event === "ws-doc-fwd");
    assert(fwds.length === 0, `idle period should have no ws-doc-fwd, got ${fwds.length}`);
    A.close();
  });

  // ──── Multi-tab steady state (156–160) ────

  t(156, "two tabs, single keystroke in tab1 → tab2 receives EXACTLY one update worth", async () => {
    const cookie = state.ownerCookie;
    const path = "emerg-156-" + Date.now() + ".txt";
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: "", encoding: "utf8" }) });
    const A = new Peer("A", cookie, state.driveId, path);
    const B = new Peer("B", cookie, state.driveId, path);
    await A.connect(); await B.connect();
    await sleep(500);
    const before = B.text();
    A.type("k");
    await sleep(800);
    eq(B.text(), before + "k", "B should reflect single insertion");
    A.close(); B.close();
  });

  t(157, "two idle tabs → zero server-side ws-doc-fwd in 5s", async () => {
    const cookie = state.ownerCookie;
    const path = "emerg-157-" + Date.now() + ".txt";
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: "init", encoding: "utf8" }) });
    const docId = docIdFor(state.driveId, path);
    const A = new Peer("A", cookie, state.driveId, path);
    const B = new Peer("B", cookie, state.driveId, path);
    await A.connect(); await B.connect();
    await sleep(800);
    const since = Date.now();
    await sleep(5000);
    const events = await fetchTraces({ docId, since, limit: 500 });
    const fwds = events.filter((e) => e.event === "ws-doc-fwd" && e.extra?.t === "sync");
    eq(fwds.length, 0, "idle 2-tab session should have zero sync forwards");
    A.close(); B.close();
  });

  t(158, "after autosave from tab1, tab2 does NOT trigger its own autosave from echo", async () => {
    const cookie = state.ownerCookie;
    const path = "emerg-158-" + Date.now() + ".txt";
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: "", encoding: "utf8" }) });
    const docId = docIdFor(state.driveId, path);
    const A = new Peer("A", cookie, state.driveId, path);
    const B = new Peer("B", cookie, state.driveId, path);
    await A.connect(); await B.connect();
    await sleep(500);
    A.type("kk");
    await sleep(500);
    const update = Y.encodeStateAsUpdate(A.doc);
    const since = Date.now();
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: A.text(), encoding: "utf8" }) });
    await jget(`/api/drives/${state.driveId}/yjs`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ docId, path, data: bytesToB64(update) }) });
    await sleep(2000);
    eq(A.reloadCount(), 0, "A must not get reload from its own write");
    eq(B.reloadCount(), 0, "B must not get reload from A's write either (suppressed)");
    A.close(); B.close();
    void since;
  });

  t(159, "three peers all idle: server keeps zero work in steady state", async () => {
    const cookie = state.ownerCookie;
    const path = "emerg-159-" + Date.now() + ".txt";
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: "", encoding: "utf8" }) });
    const docId = docIdFor(state.driveId, path);
    const peers = [];
    for (const n of ["A","B","C"]) {
      const p = new Peer(n, cookie, state.driveId, path);
      await p.connect();
      peers.push(p);
    }
    await sleep(500);
    const since = Date.now();
    await sleep(4000);
    const events = await fetchTraces({ docId, since, limit: 500 });
    const noisy = events.filter((e) => e.event === "ws-doc-fwd");
    assert(noisy.length === 0, "idle 3-peer should have no fwd events, got " + noisy.length);
    peers.forEach((p) => p.close());
  });

  t(160, "long session realistic: type-pause-type produces NO V9/V10 violations", async () => {
    const cookie = state.ownerCookie;
    const path = "emerg-160-" + Date.now() + ".txt";
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: "", encoding: "utf8" }) });
    const docId = docIdFor(state.driveId, path);
    const since = Date.now();
    const A = new Peer("A", cookie, state.driveId, path);
    await A.connect();
    // Burst 1
    A.type("hello ");
    await sleep(400);
    let update = Y.encodeStateAsUpdate(A.doc);
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: A.text(), encoding: "utf8" }) });
    await jget(`/api/drives/${state.driveId}/yjs`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ docId, path, data: bytesToB64(update) }) });
    await sleep(2000);
    // Burst 2
    A.type("world");
    await sleep(400);
    update = Y.encodeStateAsUpdate(A.doc);
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: A.text(), encoding: "utf8" }) });
    await jget(`/api/drives/${state.driveId}/yjs`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ docId, path, data: bytesToB64(update) }) });
    await sleep(2000);
    // Reconstruct what the browser WOULD have emitted; combine with server traces
    const liveEvents = await fetchTraces({ docId, since, limit: 1000 });
    // Synthesize browser-side autosave-flush events around our manual writes
    const synth = [
      { t: since,        docId, src: "browser", session: "S160", event: "provider-connect" },
      { t: since + 10,   docId, src: "browser", session: "S160", event: "provider-sub-ok", extra: { role: "owner", peers: 1 } },
      { t: since + 500,  docId, src: "browser", session: "S160", event: "ydoc-update", origin: "local", byteLen: 6, textLen: 6 },
      { t: since + 600,  docId, src: "browser", session: "S160", event: "autosave-flush" },
      { t: since + 2900, docId, src: "browser", session: "S160", event: "ydoc-update", origin: "local", byteLen: 5, textLen: 11 },
      { t: since + 3000, docId, src: "browser", session: "S160", event: "autosave-flush" },
      ...liveEvents,
    ];
    const out = runDiagnose(synth);
    assert(!/V9 autosave-induced-reload-loop/.test(out), "loop detected in long session: " + out);
    assert(!/V10 reload-echo-no-op/.test(out), "echo detected in long session: " + out);
    A.close();
  });
}
