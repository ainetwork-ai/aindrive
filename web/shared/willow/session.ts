// web/shared/willow/session.ts
// One sync session over one channel (plan 2 ruling): 3D range-based set
// reconciliation on start (the algorithm WGPS uses, on Store.summarise /
// splitRange / queryRange), then live push of every entry the store gains that
// did not come from this peer. `accept` is the receiver's ingest check (the server
// peer's author + role check); a refusal is reported back, never dropped silently.
import { OPEN_END, isIncluded3d, type Entry, type Range3d } from "@jsr/earthstar__willow-utils";
import { toHex, partsOf } from "./bytes";
import type { AnyStore } from "./doc";
import { decodeEntry, decodeRange, encodeEntry, encodeRange, type Frame, type WireEntry } from "./wire";

type B = Uint8Array;
export type Channel = { send(f: Frame): void; onFrame(cb: (f: Frame) => void): void; onClose(cb: () => void): void };
export type SessionOpts = {
  store: AnyStore;
  channel: Channel;
  ranges: Range3d<B>[];
  accept?(e: WireEntry): Promise<string | null>;
  onRefused?(f: Extract<Frame, { t: "refused" }>): void;
  onSynced?(): void;
};

const LEAF = 8; // at or below this many entries, send them instead of splitting

export const fullRange = (): Range3d<B> => ({
  subspaceRange: { start: new Uint8Array(32), end: OPEN_END },
  pathRange: { start: [], end: OPEN_END },
  timeRange: { start: 0n, end: OPEN_END },
});

let nextSource = 0;

export class SyncSession {
  private readonly source = `session-${++nextSource}`;
  private closed = false;
  private pending = 0;
  private readonly off: (() => void)[] = [];
  // entries this session received from its peer: never pushed back (the store's
  // payloadingest event does not say where an entry came from)
  private readonly fromPeer = new Set<string>();
  private static key(e: Entry<B, B, B>) { return `${toHex(e.subspaceId)}/${e.path.map(toHex).join("/")}/${e.timestamp}`; }

  constructor(private readonly o: SessionOpts) {}

  async start(): Promise<void> {
    this.o.channel.onFrame((f) => { void this.onFrame(f); });
    this.o.channel.onClose(() => this.close());
    const push = (ev: Event) => {
      const d = (ev as CustomEvent<{ entry: Entry<B, B, B>; authToken: B; externalSourceId?: string }>).detail;
      if (this.closed || this.fromPeer.has(SyncSession.key(d.entry)) || !this.inRanges(d.entry)) return;
      void this.sendLive(d.entry, d.authToken);
    };
    for (const name of ["entrypayloadset", "payloadingest"]) {
      this.o.store.addEventListener(name, push);
      this.off.push(() => this.o.store.removeEventListener(name, push));
    }
    for (const r of this.o.ranges) await this.sendFp(r);
  }

  close() {
    this.closed = true;
    for (const f of this.off.splice(0)) f();
  }

  private inRanges(e: Entry<B, B, B>) {
    return this.o.ranges.some((r) => isIncluded3d(orderSubspace, r, { subspace: e.subspaceId, path: e.path, time: e.timestamp }));
  }

  private async sendFp(range: Range3d<B>) {
    const { fingerprint, size } = await this.o.store.summarise(range);
    this.o.channel.send({ t: "fp", range: encodeRange(range), fp: toHex(fingerprint as B), size });
  }

  private async entriesIn(range: Range3d<B>): Promise<unknown[]> {
    const out: unknown[] = [];
    for await (const [entry, payload, token] of this.o.store.queryRange(range, "oldest")) {
      out.push(encodeEntry({ entry, token, payload: payload ? await payload.bytes() : undefined }));
    }
    return out;
  }

  private async sendLive(entry: Entry<B, B, B>, token: B) {
    const payload = await this.o.store.getPayload(entry);
    this.o.channel.send({ t: "live", entry: encodeEntry({ entry, token, payload: payload ? await payload.bytes() : undefined }) });
  }

  private async ingest(j: unknown): Promise<void> {
    const w = decodeEntry(j, this.o.store.namespace);
    const reject = (reason: string) =>
      this.o.channel.send({ t: "refused", path: partsOf(w.entry.path), subspace: toHex(w.entry.subspaceId), reason });
    const why = this.o.accept ? await this.o.accept(w) : null;
    if (why) return reject(why);
    this.fromPeer.add(SyncSession.key(w.entry));
    const r = await this.o.store.ingestEntry(w.entry, w.token, this.source);
    if (r.kind === "failure") return reject(r.reason ?? "invalid");
    if (w.payload) {
      async function* one(b: B) { yield b; }
      await this.o.store.ingestPayload({ path: w.entry.path, timestamp: w.entry.timestamp, subspace: w.entry.subspaceId }, one(w.payload));
    }
  }

  private async onFrame(f: Frame) {
    if (this.closed) return;
    this.pending++;
    try {
      if (f.t === "fp") {
        const range = decodeRange(f.range);
        const mine = await this.o.store.summarise(range);
        if (toHex(mine.fingerprint as B) === f.fp) return;
        if (mine.size <= LEAF || f.size <= LEAF) {
          this.o.channel.send({ t: "items", range: f.range, entries: await this.entriesIn(range), reply: true });
          return;
        }
        const [a, b] = await this.o.store.splitRange(range, mine.size);
        await this.sendFp(a);
        await this.sendFp(b);
      } else if (f.t === "items") {
        const range = decodeRange(f.range);
        const had = new Set<string>();
        for (const j of f.entries) {
          const e = j as { s: string; p: string[]; ts: string };
          had.add(`${e.s}/${e.p.join("/")}/${e.ts}`);
          await this.ingest(j);
        }
        if (f.reply) {
          const mine = (await this.entriesIn(range)).filter((j) => {
            const e = j as { s: string; p: string[]; ts: string };
            return !had.has(`${e.s}/${e.p.join("/")}/${e.ts}`);
          });
          this.o.channel.send({ t: "items", range: f.range, entries: mine, reply: false });
        }
      } else if (f.t === "live") {
        await this.ingest(f.entry);
      } else if (f.t === "refused") {
        this.o.onRefused?.(f);
      }
    } finally {
      if (--this.pending === 0) this.o.onSynced?.();
    }
  }
}

// Subspace order for range inclusion checks: bytewise, as in schemes.ts.
function orderSubspace(a: B, b: B): -1 | 0 | 1 {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}
