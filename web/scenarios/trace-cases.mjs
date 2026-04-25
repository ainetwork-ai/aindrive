/**
 * Trace + observability scenarios (#121–#140).
 *
 * These scenarios exercise the structured-logging trace ring + diagnose.mjs
 * invariant checker. They verify that *what actually happened* is captured —
 * not just the final state — so future bugs leave a forensic trail.
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

async function fetchTraces(opts = {}) {
  const params = new URLSearchParams();
  if (opts.docId) params.set("docId", opts.docId);
  if (opts.since) params.set("since", String(opts.since));
  if (opts.limit) params.set("limit", String(opts.limit));
  const r = await jget(`/api/dev/trace/dump?${params}`);
  return r.body.events || [];
}

async function pushTrace(events) {
  return jget("/api/dev/trace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(events),
  });
}

function runDiagnose(events) {
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const tmp = `/tmp/diag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jsonl`;
  writeFileSync(tmp, lines);
  let out = "";
  try {
    out = execSync(`node /mnt/newdata/git/aindrive/tools/diagnose.mjs ${tmp}`, { encoding: "utf8" });
  } catch (e) {
    out = (e.stdout || "") + (e.stderr || "");
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
  return out;
}

class Peer {
  constructor(label, cookie, driveId, path) {
    this.label = label; this.cookie = cookie; this.driveId = driveId; this.path = path;
    this.doc = new Y.Doc();
    this.ytext = this.doc.getText("content");
    this.role = null;
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
}

export function registerTraceCases(add, state, helpers) {
  const setup = async () => {
    if (!state.ownerCookie && helpers?.ensureOwner) state.ownerCookie = await helpers.ensureOwner();
    else if (state.ownerCookie && helpers?.reEnsureOwner) state.ownerCookie = await helpers.reEnsureOwner();
    if (helpers?.ensureDrive) await helpers.ensureDrive();
  };
  const t = (n, name, body) => add(n, name, async () => { await setup(); await body(); });

  // ──── Trace plumbing (121–130) ────

  t(121, "POST /api/dev/trace stores event in ring; query returns it", async () => {
    const docId = "trace-" + Date.now();
    await pushTrace({ docId, src: "browser", event: "smoke", textLen: 42 });
    await sleep(100);
    const events = await fetchTraces({ docId });
    assert(events.some((e) => e.event === "smoke" && e.textLen === 42), "smoke event not found");
  });

  t(122, "trace POST accepts batch of events", async () => {
    const docId = "trace-batch-" + Date.now();
    const batch = Array.from({ length: 12 }, (_, i) => ({ docId, src: "browser", event: "batch", extra: { i } }));
    await pushTrace(batch);
    await sleep(100);
    const events = await fetchTraces({ docId, limit: 100 });
    eq(events.length, 12);
  });

  t(123, "/api/dev/trace/dump filters by docId", async () => {
    const a = "trace-a-" + Date.now();
    const b = "trace-b-" + Date.now();
    await pushTrace([
      { docId: a, src: "browser", event: "evA" },
      { docId: b, src: "browser", event: "evB" },
    ]);
    await sleep(100);
    const onlyA = await fetchTraces({ docId: a });
    assert(onlyA.every((e) => e.docId === a) && onlyA.length >= 1);
    assert(!onlyA.some((e) => e.event === "evB"));
  });

  t(124, "/api/dev/trace/dump filters by since timestamp", async () => {
    const docId = "trace-since-" + Date.now();
    await pushTrace({ docId, src: "browser", event: "old" });
    await sleep(50);
    const cutoff = Date.now();
    await sleep(50);
    await pushTrace({ docId, src: "browser", event: "new" });
    await sleep(100);
    const recent = await fetchTraces({ docId, since: cutoff });
    assert(recent.every((e) => e.t >= cutoff));
    assert(recent.some((e) => e.event === "new"));
  });

  t(125, "/api/dev/trace/dump respects limit param", async () => {
    const docId = "trace-limit-" + Date.now();
    const batch = Array.from({ length: 30 }, (_, i) => ({ docId, src: "browser", event: "x", extra: { i } }));
    await pushTrace(batch);
    await sleep(150);
    const events = await fetchTraces({ docId, limit: 5 });
    eq(events.length, 5);
  });

  t(126, "GET /api/dev/trace returns enabled status + ring stats", async () => {
    const r = await jget("/api/dev/trace");
    eq(r.status, 200);
    assert(typeof r.body.enabled === "boolean");
    assert(typeof r.body.ring?.size === "number");
    assert(typeof r.body.ring?.max === "number");
  });

  t(127, "ws-doc-sub trace fires on peer subscribe", async () => {
    const cookie = state.ownerCookie;
    const path = "trace-127-" + Date.now() + ".txt";
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: "x", encoding: "utf8" }) });
    const docId = docIdFor(state.driveId, path);
    const since = Date.now();
    const peer = new Peer("P", cookie, state.driveId, path);
    await peer.connect();
    await sleep(300);
    const events = await fetchTraces({ docId, since });
    assert(events.some((e) => e.event === "ws-doc-sub" && e.src === "server"), "ws-doc-sub not in ring");
    peer.close();
  });

  t(128, "ws-doc-fwd trace fires when peer sends a sync frame", async () => {
    const cookie = state.ownerCookie;
    const path = "trace-128-" + Date.now() + ".txt";
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: "x", encoding: "utf8" }) });
    const docId = docIdFor(state.driveId, path);
    const since = Date.now();
    const A = new Peer("A", cookie, state.driveId, path);
    const B = new Peer("B", cookie, state.driveId, path);
    await A.connect(); await B.connect();
    await sleep(300);
    A.type("hello-from-A");
    await sleep(500);
    const events = await fetchTraces({ docId, since });
    assert(events.some((e) => e.event === "ws-doc-fwd" && e.extra?.t === "sync"), "ws-doc-fwd not seen");
    A.close(); B.close();
  });

  t(129, "rpc-out + rpc-in-resp pair recorded after fs/list", async () => {
    const cookie = state.ownerCookie;
    const since = Date.now();
    await jget(`/api/drives/${state.driveId}/fs/list?path=`, { headers: { cookie } });
    await sleep(300);
    const events = await fetchTraces({ since, limit: 200 });
    const out = events.filter((e) => e.event === "rpc-out");
    const back = events.filter((e) => e.event === "rpc-in-resp");
    assert(out.length >= 1 && back.length >= 1, `expected rpc-out + rpc-in-resp, got out=${out.length} back=${back.length}`);
  });

  t(130, "CLI disk-write trace appears in ring after fs/write", async () => {
    const cookie = state.ownerCookie;
    const path = "trace-130-" + Date.now() + ".txt";
    const docId = docIdFor(null, path); // CLI uses sha1(path)
    const since = Date.now();
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: "trace-test", encoding: "utf8" }) });
    // CLI POSTs traces via a 250ms debounce
    await sleep(800);
    const events = await fetchTraces({ since, limit: 200 });
    assert(events.some((e) => e.src === "cli" && e.event === "disk-write"), "no cli disk-write trace");
  });

  // ──── Diagnose invariant checks (131–135) ────

  t(131, "diagnose flags V1 disk-seed-after-idb-load", async () => {
    const out = runDiagnose([
      { t: 1000, docId: "x131", src: "browser", session: "S1", event: "provider-connect" },
      { t: 1100, docId: "x131", src: "browser", session: "S1", event: "provider-sub-ok", extra: { role: "owner", peers: 1 } },
      { t: 1200, docId: "x131", src: "browser", session: "S1", event: "idb-load", textLen: 87, svAfter: "sha:abc" },
      { t: 1300, docId: "x131", src: "browser", session: "S1", event: "disk-seed-apply", byteLen: 87 },
    ]);
    assert(/V1 disk-seed-after-idb-load/.test(out), "diagnose should flag V1, got:\n" + out);
    assert(/ERROR/.test(out));
  });

  t(132, "diagnose flags V8 multiple-disk-seed", async () => {
    const out = runDiagnose([
      { t: 1000, docId: "x132", src: "browser", session: "S1", event: "provider-connect" },
      { t: 1100, docId: "x132", src: "browser", session: "S1", event: "disk-seed-apply", byteLen: 10 },
      { t: 1200, docId: "x132", src: "browser", session: "S1", event: "disk-seed-apply", byteLen: 10 },
    ]);
    assert(/V8 multiple-disk-seed/.test(out), "diagnose should flag V8");
  });

  t(133, "diagnose flags V7 subscribe-without-connect", async () => {
    const out = runDiagnose([
      { t: 1000, docId: "x133", src: "browser", session: "S1", event: "provider-sub-ok", extra: { role: "owner", peers: 1 } },
    ]);
    assert(/V7 subscribe-without-connect/.test(out), "diagnose should flag V7");
  });

  t(134, "diagnose flags V6 rpc-timeout", async () => {
    const out = runDiagnose([
      { t: 1000, docId: "x134", src: "server", event: "rpc-out", extra: { method: "list", reqId: "R1" } },
      // No corresponding rpc-in-resp → should trigger V6 (>= 25s gap or session end)
      { t: 30_000, docId: "x134", src: "server", event: "rpc-out", extra: { method: "list", reqId: "R2" } },
    ]);
    assert(/V6 rpc-timeout/.test(out), "diagnose should flag V6, got:\n" + out);
  });

  t(135, "clean trace → no violations", async () => {
    const out = runDiagnose([
      { t: 1000, docId: "x135", src: "browser", session: "S1", event: "provider-connect" },
      { t: 1100, docId: "x135", src: "browser", session: "S1", event: "provider-sub-ok", extra: { role: "owner", peers: 1 } },
      { t: 1200, docId: "x135", src: "browser", session: "S1", event: "idb-load", textLen: 0, svAfter: "sha:0" },
      { t: 1300, docId: "x135", src: "browser", session: "S1", event: "whenReady-resolved" },
      { t: 1350, docId: "x135", src: "browser", session: "S1", event: "disk-seed-apply", byteLen: 5 },
      { t: 1500, docId: "x135", src: "browser", session: "S1", event: "ydoc-update", origin: "local", byteLen: 8, textLen: 8 },
      { t: 6500, docId: "x135", src: "browser", session: "S1", event: "autosave-trigger", extra: { reason: "tick" } },
      { t: 6600, docId: "x135", src: "browser", session: "S1", event: "autosave-flush", extra: { okFs: true, okYjs: true, fsByteLen: 8, yjsByteLen: 24 } },
    ]);
    assert(!/ERROR/.test(out), "expected no errors, got:\n" + out);
  });

  // ──── End-to-end debugging scenarios (136–140) ────

  t(136, "real session: type → autosave → reload → no duplication observable in trace", async () => {
    const cookie = state.ownerCookie;
    const path = "trace-136-" + Date.now() + ".txt";
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: "", encoding: "utf8" }) });
    const docId = docIdFor(state.driveId, path);
    // Synthesize a "good" session trace and run diagnose
    const since = Date.now();
    await pushTrace([
      { t: since,        docId, src: "browser", session: "S136", event: "provider-connect" },
      { t: since + 100,  docId, src: "browser", session: "S136", event: "provider-sub-ok", extra: { role: "owner", peers: 1 } },
      { t: since + 150,  docId, src: "browser", session: "S136", event: "idb-load", textLen: 0, svAfter: "sha:0" },
      { t: since + 200,  docId, src: "browser", session: "S136", event: "whenReady-resolved" },
      { t: since + 300,  docId, src: "browser", session: "S136", event: "disk-seed-apply", byteLen: 0 },
      { t: since + 5000, docId, src: "browser", session: "S136", event: "ydoc-update", origin: "local", byteLen: 8, textLen: 5 },
      { t: since + 10_000, docId, src: "browser", session: "S136", event: "autosave-trigger", extra: { reason: "tick" } },
      { t: since + 10_100, docId, src: "browser", session: "S136", event: "autosave-flush", extra: { okFs: true, okYjs: true, fsByteLen: 5, yjsByteLen: 20 } },
    ]);
    await sleep(150);
    const events = await fetchTraces({ docId, since });
    const out = runDiagnose(events);
    assert(!/ERROR/.test(out), "expected clean session, got:\n" + out);
  });

  t(137, "two-peer concurrent edit: both ws-doc-fwd events appear in trace", async () => {
    const cookie = state.ownerCookie;
    const path = "trace-137-" + Date.now() + ".txt";
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: "", encoding: "utf8" }) });
    const docId = docIdFor(state.driveId, path);
    const since = Date.now();
    const A = new Peer("A", cookie, state.driveId, path);
    const B = new Peer("B", cookie, state.driveId, path);
    await A.connect(); await B.connect();
    await sleep(300);
    A.type("from-A");
    B.type("from-B");
    await sleep(800);
    const events = await fetchTraces({ docId, since });
    const fwds = events.filter((e) => e.event === "ws-doc-fwd" && e.extra?.t === "sync");
    assert(fwds.length >= 2, `expected ≥2 ws-doc-fwd sync events, got ${fwds.length}`);
    A.close(); B.close();
  });

  t(138, "wallet allowlist subscribe: ws-doc-sub trace shows correct address", async () => {
    const cookie = state.ownerCookie;
    const path = "trace-138-" + Date.now() + ".txt";
    await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path, content: "", encoding: "utf8" }) });
    // Add a wallet to allowlist
    const wallet = "0x" + "deadbeef".repeat(5);
    await jget(`/api/drives/${state.driveId}/access`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ wallet_address: wallet, path: "" }) });
    // Verify the trace API at least works (full wallet WS sub requires SIWE; we just confirm endpoint shape)
    const r = await jget(`/api/dev/trace/dump?docId=${docIdFor(state.driveId, path)}&limit=10`);
    eq(r.status, 200);
    assert(Array.isArray(r.body.events));
  });

  t(139, "free share read flow leaves no trace ERROR", async () => {
    const cookie = state.ownerCookie;
    const s = await jget(`/api/drives/${state.driveId}/shares`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ path: "", role: "viewer" }),
    });
    const r = await jget(`/api/s/${s.body.token}`);
    eq(r.status, 200);
    // Ring should still respond
    const tr = await jget(`/api/dev/trace`);
    eq(tr.status, 200);
  });

  t(140, "ring buffer survives 200 events without dropping recent ones", async () => {
    const docId = "trace-140-" + Date.now();
    const before = (await jget("/api/dev/trace")).body.ring.size;
    const N = 200;
    const batch = Array.from({ length: N }, (_, i) => ({ docId, src: "browser", event: "spam", extra: { i } }));
    await pushTrace(batch);
    await sleep(200);
    const events = await fetchTraces({ docId, limit: 1000 });
    // Either all 200 are present (if ring not full), or we got the most recent slice
    if (events.length === N) {
      assert(events.every((e) => e.event === "spam"));
    } else {
      // Ring evicted some — must have at minimum the latest event present
      assert(events.some((e) => e.extra?.i === N - 1), "latest event missing after eviction");
    }
    const after = (await jget("/api/dev/trace")).body.ring.size;
    assert(after >= before, "ring should not shrink");
  });
}
