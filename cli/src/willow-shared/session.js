// GENERATED from web/shared/willow/session.ts by web/scripts/mirror-willow-to-cli.mjs — do not edit.
import { OPEN_END, isIncluded3d } from "@jsr/earthstar__willow-utils";
import { toHex, partsOf } from "./bytes.js";
import { decodeEntry, decodeRange, encodeEntry, encodeRange } from "./wire.js";
const LEAF = 8;
const CHUNK = 256;
const MAX_FP = 5e4;
const fullRange = () => ({
  subspaceRange: { start: new Uint8Array(32), end: OPEN_END },
  pathRange: { start: [], end: OPEN_END },
  timeRange: { start: 0n, end: OPEN_END }
});
let nextSource = 0;
class SyncSession {
  constructor(o) {
    this.o = o;
  }
  o;
  source = `session-${++nextSource}`;
  closed = false;
  // Reconciliation bookkeeping: ranges I sent a fingerprint for and the peer has
  // not answered yet; whether the peer's last word was "synced". Frames are
  // handled one at a time, in arrival order, so "synced" is only seen after
  // everything the peer sent before it.
  open = /* @__PURE__ */ new Map();
  // range key → answers still owed
  partial = /* @__PURE__ */ new Map();
  // chunked items: keys seen so far per range
  fps = 0;
  peerSynced = false;
  queue = Promise.resolve();
  off = [];
  // entries this session received from its peer: never pushed back (the store's
  // payloadingest event does not say where an entry came from)
  fromPeer = /* @__PURE__ */ new Set();
  static key(e) {
    return `${toHex(e.subspaceId)}/${e.path.map(toHex).join("/")}/${e.timestamp}`;
  }
  async start() {
    this.o.channel.onFrame((f) => {
      this.queue = this.queue.then(() => this.onFrame(f)).catch(() => {
      });
    });
    this.o.channel.onClose(() => this.close());
    const push = (ev) => {
      const d = ev.detail;
      if (this.closed || this.fromPeer.has(SyncSession.key(d.entry)) || !this.inRanges(d.entry) || !this.allowed(d.entry)) return;
      void this.sendLive(d.entry, d.authToken);
    };
    for (const name of ["entrypayloadset", "payloadingest"]) {
      this.o.store.addEventListener(name, push);
      this.off.push(() => this.o.store.removeEventListener(name, push));
    }
    this.queue = this.queue.then(async () => {
      for (const r of this.o.ranges) if (!this.closed) await this.sendFp(r);
      if (this.o.ranges.length === 0) this.o.channel.send({ t: "synced" });
    });
    await this.queue;
  }
  close() {
    this.closed = true;
    for (const f of this.off.splice(0)) f();
  }
  /** Resolves once the frame being handled (if any) is done: close() first, then await this before closing the store. */
  drained() {
    return this.queue;
  }
  allowed(e) {
    try {
      return this.o.allow ? this.o.allow(e) : true;
    } catch {
      return false;
    }
  }
  /** Items in frames of at most CHUNK entries; only the last one replies/answers. */
  sendItems(range, entries, reply, re) {
    for (let i = 0; i < entries.length || i === 0; i += CHUNK) {
      const last = i + CHUNK >= entries.length;
      this.o.channel.send({ t: "items", range, entries: entries.slice(i, i + CHUNK), reply: reply && last, re: last ? re : void 0, more: !last || void 0 });
      if (entries.length === 0) break;
    }
  }
  inRanges(e) {
    return this.o.ranges.some((r) => isIncluded3d(orderSubspace, r, { subspace: e.subspaceId, path: e.path, time: e.timestamp }));
  }
  async sendFp(range, re) {
    const { fingerprint, size } = await this.o.store.summarise(range);
    const enc = encodeRange(range);
    const k = JSON.stringify(enc);
    this.open.set(k, (this.open.get(k) ?? 0) + 1);
    this.o.channel.send({ t: "fp", range: enc, fp: toHex(fingerprint), size, re });
  }
  /** After each frame: tell the peer when I have nothing open; report synced when
   *  neither side has anything open. */
  settle(wasOpen) {
    if (this.open.size === 0 && wasOpen > 0) this.o.channel.send({ t: "synced" });
    if (this.open.size === 0 && this.peerSynced) this.o.onSynced?.();
  }
  async entriesIn(range) {
    const out = [];
    for await (const [entry, payload, token] of this.o.store.queryRange(range, "oldest")) {
      if (!this.allowed(entry)) continue;
      out.push(encodeEntry({ entry, token, payload: payload ? await payload.bytes() : void 0 }));
    }
    return out;
  }
  async sendLive(entry, token) {
    const payload = await this.o.store.getPayload(entry);
    this.o.channel.send({ t: "live", entry: encodeEntry({ entry, token, payload: payload ? await payload.bytes() : void 0 }) });
  }
  async ingest(j) {
    const w = decodeEntry(j, this.o.store.namespace);
    const reject = (reason) => this.o.channel.send({ t: "refused", path: partsOf(w.entry.path), subspace: toHex(w.entry.subspaceId), reason });
    const why = this.o.accept ? await this.o.accept(w) : null;
    if (why) return reject(why);
    this.fromPeer.add(SyncSession.key(w.entry));
    const r = await this.o.store.ingestEntry(w.entry, w.token, this.source);
    if (r.kind === "failure") return reject(r.reason ?? "invalid");
    if (w.payload) {
      async function* one(b) {
        yield b;
      }
      await this.o.store.ingestPayload({ path: w.entry.path, timestamp: w.entry.timestamp, subspace: w.entry.subspaceId }, one(w.payload));
    }
  }
  async onFrame(f) {
    if (this.closed) return;
    const wasOpen = this.open.size;
    if ("re" in f && f.re) {
      const n = (this.open.get(f.re) ?? 0) - 1;
      if (n > 0) this.open.set(f.re, n);
      else this.open.delete(f.re);
    }
    if (f.t === "fp") {
      if (++this.fps > MAX_FP) return this.close();
      this.peerSynced = false;
      const range = decodeRange(f.range);
      const key = JSON.stringify(f.range);
      const mine = await this.o.store.summarise(range);
      if (toHex(mine.fingerprint) === f.fp) this.o.channel.send({ t: "eq", re: key });
      else if (mine.size <= LEAF) this.sendItems(f.range, await this.entriesIn(range), true, key);
      else {
        const [a, b] = await this.o.store.splitRange(range, mine.size);
        await this.sendFp(a, key);
        await this.sendFp(b);
      }
    } else if (f.t === "items") {
      if (!Array.isArray(f.entries) || f.entries.length > CHUNK) return this.close();
      if (f.reply) this.peerSynced = false;
      const range = decodeRange(f.range);
      const key = JSON.stringify(f.range);
      const had = this.partial.get(key) ?? /* @__PURE__ */ new Set();
      for (const j of f.entries) {
        const e = j;
        had.add(`${e.s}/${e.p.join("/")}/${e.ts}`);
        await this.ingest(j);
      }
      if (f.more) this.partial.set(key, had);
      else {
        this.partial.delete(key);
        if (f.reply) {
          const mine = (await this.entriesIn(range)).filter((j) => {
            const e = j;
            return !had.has(`${e.s}/${e.p.join("/")}/${e.ts}`);
          });
          this.sendItems(f.range, mine, false);
        }
      }
    } else if (f.t === "synced") {
      this.peerSynced = true;
    } else if (f.t === "live") {
      await this.ingest(f.entry);
    } else if (f.t === "refused") {
      this.o.onRefused?.(f);
    }
    this.settle(wasOpen);
  }
}
function orderSubspace(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}
export {
  SyncSession,
  fullRange
};
