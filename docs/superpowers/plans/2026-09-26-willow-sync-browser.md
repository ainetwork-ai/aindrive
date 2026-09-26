# Willow sync, server peer and browser client (Plan 2 of 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A document edited in the browser is stored as signed Willow entries in the
browser, syncs through the aindrive server (one peer among others), survives going
offline and reloading, and shows who wrote each part.

**Architecture:** Plan 1's pure building blocks plus: a sync session (range-based set
reconciliation on connect + live push of new entries) in `web/shared/willow/`, a
server peer (SQLite store per drive, WebSocket endpoint `/api/willow/sync`, author
and role check at ingest, certificate issuing), a browser client (IndexedDB store,
device key, the same session), a Yjs binding that replaces the provider's persistence
and autosave, and a service worker for offline open.

**Tech Stack:** as Plan 1, plus `better-sqlite3` (server store), `ws` (server socket),
the browser `WebSocket`, `@earthstar/willow`'s IndexedDB drivers, Playwright for E2E.

**Spec:** `docs/superpowers/specs/2026-09-26-willow-local-first-docs-design.md`.

## Rulings carried into this plan (amend the spec in Task 7)

- **From Plan 1's review:** the server peer parses certificates only through
  `certsFrom`, judges revocation at its own clock (`now`), and refuses an update that
  reuses another device's Yjs client id (`clientClaimConflict`).

- **Sync is 3D range-based set reconciliation + live push, not `WgpsMessenger`.**
  `@earthstar/willow` 0.6's WGPS reconciles only at session start
  (`DataSender.queueEntry` is never called), so live co-editing cannot ride it. We
  use the same algorithm WGPS uses (`Store.summarise` / `splitRange` / `queryRange`)
  and push entries on the store's `entrypayloadset` / `payloadingest` events. WGPS's
  PAI and read-capability layers come in Phase 2 (spec §11 already defers read caps).
- **Phase 1 membership is enforced by the server peer**, the only path between
  devices in Phase 1. Every peer still verifies signatures and certificate chains;
  owner-signed `_acl` grants and client-side `mayWrite` arrive with Phase 2's direct
  sync. The server checks the author's role with the same `resolveRole` the rest of
  the web app uses.
- **The browser keeps its device secret key in IndexedDB as raw bytes** (noble
  signs). Cost: script running on the origin can read it. WebCrypto non-extractable
  Ed25519 is a follow-up once every target browser supports it.

## Global Constraints

- Everything from Plan 1's Global Constraints.
- Wire frames are JSON text frames; bytes are hex, payloads base64, bigints decimal strings.
- The server never signs document entries; it signs only certificates (attestation key
  from `AINDRIVE_ATTESTATION_KEY`, 64 hex chars; generated and saved to the data dir on
  first boot when unset).
- Paid paths (`paidAccessDenial`) are never synced to a session that would be refused
  over HTTP.
- `dochub` keeps awareness (cursors, presence); only document content moves to Willow.

## Review Focus

1. **A browser that was offline for a day comes back with 300 updates while another
   person edited the same doc**: both converge, no update lost, no duplicate text.
2. **A viewer (not editor) pushes an entry over the socket**: refused, and the refusal
   reaches the client instead of vanishing.
3. **The same device key used from two tabs at once**: sequence numbers must not
   collide (two entries at one path would prune one of them).
4. **The server restarts mid-session**: the client reconnects and reconciles; nothing
   is lost on either side.
5. **A paid document the viewer has not bought**: never appears in their sync session.

---

## File structure

| File | Responsibility |
|---|---|
| `web/shared/willow/wire.ts` | JSON frame codec: ranges, entries with token and payload |
| `web/shared/willow/session.ts` | `SyncSession`: reconcile on connect, live push, ingest with a hook |
| `web/lib/willow/kv-driver-sqlite.js` | Willow KV driver over better-sqlite3 (port of `cli/src/willow/kv-driver-sqlite.js`) |
| `web/lib/willow/payload-driver-fs.ts` | persistent payload driver (files named by digest) |
| `web/lib/willow/attestation.ts` | server attestation key: load/create, issue certificates |
| `web/lib/willow/peer.ts` | server peer: per-drive store, ingest check, session per socket |
| `web/app/api/willow/cert/route.ts` | issue an attested certificate for the signed-in user's device key |
| `web/shared/willow/y-binding.ts` | Y.Doc ⇄ store: local updates become entries, entries become updates |
| `web/lib/willow/client.ts` | browser: device key, IndexedDB store, certificate, socket session |
| `web/lib/yjs/aindrive-provider.ts` | keep awareness; content moves to the binding |
| `web/public/sw.js`, `web/lib/willow/offline.ts` | service worker: app shell + visited drive pages |

---

### Task 1: Wire format and sync session (in-memory, two stores converge)

**Files:**
- Create: `web/shared/willow/wire.ts`, `web/shared/willow/session.ts`
- Test: `web/lib/__tests__/willow-session.test.ts`

**Interfaces:**
- Consumes: `newStore`, `aindriveSchemes`, `encodeEntryBytes` (Plan 1 Task 1); `appendUpdate`, `loadDoc` (Plan 1 Task 4); `toHex`, `fromHex` (Plan 1)
- Produces:
  - `wire.ts`: `type WireEntry = { entry: Entry<Uint8Array,Uint8Array,Uint8Array>; token: Uint8Array; payload?: Uint8Array }`,
    `encodeRange(r: Range3d<Uint8Array>): unknown`, `decodeRange(j: unknown): Range3d<Uint8Array>`,
    `encodeEntry(e: WireEntry): unknown`, `decodeEntry(j: unknown, namespace: Uint8Array): WireEntry`,
    `type Frame = { t: "fp"; range: unknown; fp: string; size: number } | { t: "items"; range: unknown; entries: unknown[]; reply: boolean } | { t: "live"; entry: unknown } | { t: "refused"; path: string[]; subspace: string; reason: string } | { t: "synced" }`
  - `session.ts`: `type Channel = { send(f: Frame): void; onFrame(cb: (f: Frame) => void): void; onClose(cb: () => void): void }`,
    `type SessionOpts = { store: AnyStore; channel: Channel; ranges: Range3d<Uint8Array>[]; accept?(e: WireEntry): Promise<string | null> /* null = ok, else reason */; covers?(e: Entry<...>): boolean; onRefused?(f: Extract<Frame,{t:"refused"}>): void; onSynced?(): void }`,
    `class SyncSession { constructor(o: SessionOpts); start(): Promise<void>; close(): void }`,
    `fullRange(): Range3d<Uint8Array>` (every subspace, path and time)

- [ ] **Step 1: Write the failing test**

```ts
// web/lib/__tests__/willow-session.test.ts
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { generateDeviceKey } from "@/shared/willow/keys";
import { newStore } from "@/shared/willow/schemes";
import { appendUpdate, loadDoc } from "@/shared/willow/doc";
import { SyncSession, fullRange, type Channel } from "@/shared/willow/session";
import type { Frame } from "@/shared/willow/wire";

function pipe(): [Channel, Channel] {
  const make = () => ({ frame: [] as ((f: Frame) => void)[], close: [] as (() => void)[] });
  const a = make(), b = make();
  const chan = (me: typeof a, other: typeof a): Channel => ({
    // JSON round trip: the real socket carries text
    send: (f) => queueMicrotask(() => other.frame.forEach((cb) => cb(JSON.parse(JSON.stringify(f))))),
    onFrame: (cb) => me.frame.push(cb),
    onClose: (cb) => me.close.push(cb),
  });
  return [chan(a, b), chan(b, a)];
}

const text = (s: string, client: number) => { const d = new Y.Doc(); d.clientID = client; d.getText("content").insert(0, s); return Y.encodeStateAsUpdate(d); };
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("SyncSession", () => {
  it("two stores with divergent offline edits converge on connect", async () => {
    const mom = await generateDeviceKey(), kid = await generateDeviceKey();
    const s1 = newStore("d"), s2 = newStore("d");
    for (let i = 1; i <= 40; i++) await appendUpdate(s1, mom, ["a.md"], text(`m${i} `, 1000 + i), i);
    for (let i = 1; i <= 40; i++) await appendUpdate(s2, kid, ["a.md"], text(`k${i} `, 2000 + i), i);
    const [c1, c2] = pipe();
    const a = new SyncSession({ store: s1, channel: c1, ranges: [fullRange()] });
    const b = new SyncSession({ store: s2, channel: c2, ranges: [fullRange()] });
    await Promise.all([a.start(), b.start()]);
    await settle();
    const t1 = (await loadDoc(s1, ["a.md"])).getText("content").toString();
    const t2 = (await loadDoc(s2, ["a.md"])).getText("content").toString();
    expect(t1).toBe(t2);
    expect(t1).toContain("m40 ");
    expect(t1).toContain("k40 ");
  });

  it("pushes an entry written after the connect (live)", async () => {
    const mom = await generateDeviceKey();
    const s1 = newStore("d"), s2 = newStore("d");
    const [c1, c2] = pipe();
    await Promise.all([new SyncSession({ store: s1, channel: c1, ranges: [fullRange()] }).start(), new SyncSession({ store: s2, channel: c2, ranges: [fullRange()] }).start()]);
    await appendUpdate(s1, mom, ["a.md"], text("live", 7), 1);
    await settle();
    expect((await loadDoc(s2, ["a.md"])).getText("content").toString()).toBe("live");
  });

  it("an entry the receiver refuses is not stored, and the sender hears why", async () => {
    const mom = await generateDeviceKey();
    const s1 = newStore("d"), s2 = newStore("d");
    const [c1, c2] = pipe();
    const refused: string[] = [];
    const a = new SyncSession({ store: s1, channel: c1, ranges: [fullRange()], onRefused: (f) => refused.push(f.reason) });
    const b = new SyncSession({ store: s2, channel: c2, ranges: [fullRange()], accept: async () => "not-a-member" });
    await Promise.all([a.start(), b.start()]);
    await appendUpdate(s1, mom, ["a.md"], text("x", 7), 1);
    await settle();
    expect((await loadDoc(s2, ["a.md"])).getText("content").toString()).toBe("");
    expect(refused).toContain("not-a-member");
  });

  it("does not echo an entry back to the peer it came from", async () => {
    const mom = await generateDeviceKey();
    const s1 = newStore("d"), s2 = newStore("d");
    const [c1, c2] = pipe();
    let lives = 0;
    const orig = c2.send;
    c2.send = (f) => { if (f.t === "live") lives++; orig(f); };
    await Promise.all([new SyncSession({ store: s1, channel: c1, ranges: [fullRange()] }).start(), new SyncSession({ store: s2, channel: c2, ranges: [fullRange()] }).start()]);
    await appendUpdate(s1, mom, ["a.md"], text("once", 7), 1);
    await settle();
    expect(lives).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd web && npx vitest run lib/__tests__/willow-session.test.ts`
Expected: FAIL: `Cannot find module '@/shared/willow/session'`.

- [ ] **Step 3: Write `wire.ts`**

```ts
// web/shared/willow/wire.ts
// The sync wire (plan 2 ruling): JSON text frames. Bytes are hex, payloads base64,
// bigints decimal strings, OPEN_END is null. Entries carry their token (the
// device's signature) so every receiver re-checks it.
import { OPEN_END, type Entry, type Range3d } from "@jsr/earthstar__willow-utils";
import { fromHex, toHex } from "./bytes";

type B = Uint8Array;
export type WireEntry = { entry: Entry<B, B, B>; token: B; payload?: B };
export type Frame =
  | { t: "fp"; range: unknown; fp: string; size: number }
  | { t: "items"; range: unknown; entries: unknown[]; reply: boolean }
  | { t: "live"; entry: unknown }
  | { t: "refused"; path: string[]; subspace: string; reason: string }
  | { t: "synced" };

const b64 = (b: B) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const end = <T,>(v: T | typeof OPEN_END, f: (x: T) => unknown) => (v === OPEN_END ? null : f(v as T));

export function encodeRange(r: Range3d<B>): unknown {
  return {
    s: [toHex(r.subspaceRange.start), end(r.subspaceRange.end, toHex)],
    p: [r.pathRange.start.map(toHex), end(r.pathRange.end, (p: B[]) => p.map(toHex))],
    t: [r.timeRange.start.toString(), end(r.timeRange.end, (x: bigint) => x.toString())],
  };
}

export function decodeRange(j: unknown): Range3d<B> {
  const o = j as { s: [string, string | null]; p: [string[], string[] | null]; t: [string, string | null] };
  return {
    subspaceRange: { start: fromHex(o.s[0]), end: o.s[1] === null ? OPEN_END : fromHex(o.s[1]) },
    pathRange: { start: o.p[0].map(fromHex), end: o.p[1] === null ? OPEN_END : o.p[1].map(fromHex) },
    timeRange: { start: BigInt(o.t[0]), end: o.t[1] === null ? OPEN_END : BigInt(o.t[1]) },
  };
}

export function encodeEntry(e: WireEntry): unknown {
  const x = e.entry;
  return {
    s: toHex(x.subspaceId), p: x.path.map(toHex), ts: x.timestamp.toString(), n: x.payloadLength.toString(),
    d: toHex(x.payloadDigest), tok: toHex(e.token), pl: e.payload ? b64(e.payload) : undefined,
  };
}

export function decodeEntry(j: unknown, namespace: B): WireEntry {
  const o = j as { s: string; p: string[]; ts: string; n: string; d: string; tok: string; pl?: string };
  return {
    entry: { namespaceId: namespace, subspaceId: fromHex(o.s), path: o.p.map(fromHex), timestamp: BigInt(o.ts), payloadLength: BigInt(o.n), payloadDigest: fromHex(o.d) },
    token: fromHex(o.tok),
    payload: o.pl === undefined ? undefined : unb64(o.pl),
  };
}
```

- [ ] **Step 4: Write `session.ts`**

```ts
// web/shared/willow/session.ts
// One sync session over one channel (plan 2 ruling): 3D range-based set
// reconciliation on start (the algorithm WGPS uses, on Store.summarise /
// splitRange / queryRange), then live push of every entry the store gains that
// did not come from this peer. `accept` is the receiver's ingest check (the server
// peer's author + role check); a refusal is reported back, never dropped silently.
import { OPEN_END, isIncludedRange, type Entry, type Range3d } from "@jsr/earthstar__willow-utils";
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

  constructor(private readonly o: SessionOpts) {}

  async start(): Promise<void> {
    this.o.channel.onFrame((f) => { void this.onFrame(f); });
    this.o.channel.onClose(() => this.close());
    const push = (ev: Event) => {
      const d = (ev as CustomEvent<{ entry: Entry<B, B, B>; authToken: B; externalSourceId?: string }>).detail;
      if (this.closed || d.externalSourceId === this.source || !this.inRanges(d.entry)) return;
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
    return this.o.ranges.some((r) => isIncludedRange(orderSubspace, r, e));
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
    const payload = await this.o.store.getPayload?.(entry.subspaceId, entry.path);
    this.o.channel.send({ t: "live", entry: encodeEntry({ entry, token, payload: payload ? await payload.bytes() : undefined }) });
  }

  private async ingest(j: unknown): Promise<void> {
    const w = decodeEntry(j, this.o.store.namespace);
    const reject = (reason: string) =>
      this.o.channel.send({ t: "refused", path: partsOf(w.entry.path), subspace: toHex(w.entry.subspaceId), reason });
    const why = this.o.accept ? await this.o.accept(w) : null;
    if (why) return reject(why);
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
```

If `isIncludedRange`'s parameter order differs in willow-utils 2.0.1, read
`node_modules/@jsr/earthstar__willow-utils/src/ranges/ranges.ts` and match it; if
`Store.getPayload` takes a different argument, match `store.ts:805`. If
`externalSourceId` is not carried on the events, compare against a set of
`${subspace}/${path}/${timestamp}` keys this session ingested instead.

- [ ] **Step 5: Run the test until it passes**

Run: `cd web && npx vitest run lib/__tests__/willow-session.test.ts`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add web/shared/willow/wire.ts web/shared/willow/session.ts web/lib/__tests__/willow-session.test.ts
git commit -m "feat(willow): sync session — range reconciliation on connect + live push"
```

---

### Task 2: Persistent drivers for the server (SQLite entries, file payloads)

**Files:**
- Create: `web/lib/willow/kv-driver-sqlite.js` (port of `cli/src/willow/kv-driver-sqlite.js`), `web/lib/willow/kv-driver-sqlite.d.ts`, `web/lib/willow/payload-driver-fs.ts`, `web/lib/willow/store-node.ts`
- Test: `web/lib/__tests__/willow-store-node.test.ts`

**Interfaces:**
- Produces: `openDriveStore(driveId: string, dir: string): AnyStore` — a Store whose entries live in `<dir>/<driveId>.sqlite` and payloads in `<dir>/<driveId>.payloads/<digest hex>`; `closeDriveStores(): void`

- [ ] **Step 1: Write the failing test**

```ts
// web/lib/__tests__/willow-store-node.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { generateDeviceKey } from "@/shared/willow/keys";
import { appendUpdate, loadDoc } from "@/shared/willow/doc";
import { openDriveStore, closeDriveStores } from "@/lib/willow/store-node";

describe("server drive store", () => {
  it("keeps entries and payloads across a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "willow-store-"));
    const kp = await generateDeviceKey();
    const d = new Y.Doc(); d.getText("content").insert(0, "persisted");
    await appendUpdate(openDriveStore("drive-1", dir), kp, ["a.md"], Y.encodeStateAsUpdate(d), 1);
    closeDriveStores();
    expect((await loadDoc(openDriveStore("drive-1", dir), ["a.md"])).getText("content").toString()).toBe("persisted");
    closeDriveStores();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd web && npx vitest run lib/__tests__/willow-store-node.test.ts`
Expected: FAIL: `Cannot find module '@/lib/willow/store-node'`.

- [ ] **Step 3: Port the KV driver**

Copy `cli/src/willow/kv-driver-sqlite.js` to `web/lib/willow/kv-driver-sqlite.js` unchanged
except the two imports, which become:

```js
import { pack, unpack } from "../../node_modules/@earthstar/willow/src/store/storage/kv/key_codec/kv_key_codec.js";
import { compareKeys, isFirstKeyPrefixOfSecondKey } from "../../node_modules/@earthstar/willow/src/store/storage/kv/types.js";
```

and add a header comment `// Mirrors cli/src/willow/kv-driver-sqlite.js (web and cli are independent packages).`
Create `web/lib/willow/kv-driver-sqlite.d.ts`:

```ts
import type { KvDriver } from "@earthstar/willow";
import type Database from "better-sqlite3";
export declare class KvDriverSqlite implements KvDriver {
  constructor(db: Database.Database);
  get: KvDriver["get"]; set: KvDriver["set"]; delete: KvDriver["delete"]; list: KvDriver["list"]; clear: KvDriver["clear"]; batch: KvDriver["batch"];
}
```

- [ ] **Step 4: Write the payload driver and the store opener**

```ts
// web/lib/willow/payload-driver-fs.ts
// Payloads as files named by their SHA-256 digest (hex). Content-addressed, so a
// write is idempotent and a crash leaves at worst an orphan temp file.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import type { Payload, PayloadDriver } from "@earthstar/willow";
import { toHex, equalBytes } from "@/shared/willow/bytes";

type B = Uint8Array;
async function all(p: B | AsyncIterable<B>): Promise<B> {
  if (p instanceof Uint8Array) return p;
  const parts: B[] = []; for await (const c of p) parts.push(c);
  const out = new Uint8Array(parts.reduce((n, c) => n + c.length, 0)); let o = 0;
  for (const c of parts) { out.set(c, o); o += c.length; }
  return out;
}
const payloadOf = (bytes: B): Payload => ({
  bytes: async (offset = 0) => bytes.subarray(offset),
  stream: async (offset = 0) => (async function* () { yield bytes.subarray(offset); })(),
  length: async () => BigInt(bytes.length),
});

export class PayloadDriverFs implements PayloadDriver<B> {
  constructor(private readonly dir: string) { mkdirSync(dir, { recursive: true }); }
  private file(d: B) { return join(this.dir, toHex(d)); }
  private write(d: B, bytes: B) { const f = this.file(d); const tmp = `${f}.tmp-${process.pid}`; writeFileSync(tmp, bytes); renameSync(tmp, f); }
  async get(d: B) { const f = this.file(d); return existsSync(f) ? payloadOf(new Uint8Array(readFileSync(f))) : undefined; }
  async set(p: B | AsyncIterable<B>) { const bytes = await all(p); const d = sha256(bytes); this.write(d, bytes); return { digest: d, length: BigInt(bytes.length), payload: payloadOf(bytes) }; }
  async receive(o: { payload: B | AsyncIterable<B>; offset: number; expectedLength: bigint; expectedDigest: B }) {
    const prev = o.offset > 0 && existsSync(this.file(o.expectedDigest) + ".part") ? new Uint8Array(readFileSync(this.file(o.expectedDigest) + ".part")).subarray(0, o.offset) : new Uint8Array(0);
    const bytes = new Uint8Array([...prev, ...(await all(o.payload))]);
    const d = sha256(bytes);
    return {
      digest: d, length: BigInt(bytes.length),
      commit: async (complete: boolean) => {
        if (complete && equalBytes(d, o.expectedDigest)) { this.write(d, bytes); try { unlinkSync(this.file(o.expectedDigest) + ".part"); } catch {} }
        else writeFileSync(this.file(o.expectedDigest) + ".part", bytes);
      },
      reject: async () => { try { unlinkSync(this.file(o.expectedDigest) + ".part"); } catch {} },
    };
  }
  async length(d: B) { const f = this.file(d); return existsSync(f) ? BigInt(statSync(f).size) : 0n; }
  async erase(d: B) { try { unlinkSync(this.file(d)); return true; } catch { return false; } }
}
```

```ts
// web/lib/willow/store-node.ts
// The server peer's store for one drive: entries in SQLite, payloads as files.
import Database from "better-sqlite3";
import { join } from "node:path";
import { Store, EntryDriverKvStore } from "@earthstar/willow";
import { aindriveSchemes, namespaceOf } from "@/shared/willow/schemes";
import type { AnyStore } from "@/shared/willow/doc";
import { KvDriverSqlite } from "./kv-driver-sqlite.js";
import { PayloadDriverFs } from "./payload-driver-fs";

const open = new Map<string, { store: AnyStore; db: Database.Database }>();

export function openDriveStore(driveId: string, dir: string): AnyStore {
  const key = `${dir}\0${driveId}`;
  const hit = open.get(key);
  if (hit) return hit.store;
  const db = new Database(join(dir, `${driveId}.sqlite`));
  db.pragma("journal_mode = WAL");
  const payloadDriver = new PayloadDriverFs(join(dir, `${driveId}.payloads`));
  const store = new Store({
    namespace: namespaceOf(driveId),
    schemes: aindriveSchemes,
    payloadDriver,
    entryDriver: new EntryDriverKvStore({
      kvDriver: new KvDriverSqlite(db),
      namespaceScheme: aindriveSchemes.namespace, subspaceScheme: aindriveSchemes.subspace,
      payloadScheme: aindriveSchemes.payload, pathScheme: aindriveSchemes.path, fingerprintScheme: aindriveSchemes.fingerprint,
      getPayloadLength: (d) => payloadDriver.length(d),
    }),
  }) as AnyStore;
  open.set(key, { store, db });
  return store;
}

export function closeDriveStores() {
  for (const { db } of open.values()) db.close();
  open.clear();
}
```

- [ ] **Step 5: Run the test until it passes**

Run: `cd web && npx vitest run lib/__tests__/willow-store-node.test.ts`
Expected: 1 passed.

- [ ] **Step 6: Commit**

```bash
git add web/lib/willow/ web/lib/__tests__/willow-store-node.test.ts
git commit -m "feat(willow): server drive store — SQLite entries, file payloads"
```

---

### Task 3: Attestation key and certificates for signed-in devices

**Files:**
- Create: `web/lib/willow/attestation.ts`, `web/app/api/willow/cert/route.ts`
- Test: `web/lib/__tests__/willow-attestation.test.ts`

**Interfaces:**
- Consumes: `issueAttestedCert`, `resolvePerson`, `Cert` (Plan 1 Task 2); `fromHex`, `toHex` (Plan 1)
- Produces: `attestationKey(): DeviceKeypair` (env `AINDRIVE_ATTESTATION_KEY` or `<data dir>/attestation.key`, created 0600), `trust(): Trust` (attestation public key + a viem-based `verifyWallet`), `certify(userId: string, deviceKeyHex: string, label: string): Promise<Cert>`; `POST /api/willow/cert { deviceKey, label }` → `{ cert, attestationKey }` (401 when not signed in, 400 on a malformed key)

- [ ] **Step 1: Write the failing test**

```ts
// web/lib/__tests__/willow-attestation.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-att-"));
delete process.env.AINDRIVE_ATTESTATION_KEY;
const { attestationKey, certify, trust } = await import("../willow/attestation");
const { generateDeviceKey } = await import("@/shared/willow/keys");
const { resolvePerson } = await import("@/shared/willow/cert");
const { toHex } = await import("@/shared/willow/bytes");

describe("attestation", () => {
  it("creates one key and keeps it", () => {
    expect(toHex(attestationKey().publicKey)).toBe(toHex(attestationKey().publicKey));
  });
  it("certifies a device for a user, and peers trusting the key resolve it", async () => {
    const dev = await generateDeviceKey();
    const cert = await certify("u-1", toHex(dev.publicKey), "Chrome on Mac");
    expect(await resolvePerson(toHex(dev.publicKey), [cert], [], trust())).toEqual({ userId: "u-1", strength: "attested" });
  });
  it("refuses a malformed device key", async () => {
    await expect(certify("u-1", "zz", "x")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd web && npx vitest run lib/__tests__/willow-attestation.test.ts`
Expected: FAIL: `Cannot find module '../willow/attestation'`.

- [ ] **Step 3: Write `attestation.ts` and the route**

```ts
// web/lib/willow/attestation.ts
// aindrive's attestation key (spec §4): signs certificates for devices of people
// signed in with email/Google ("vouched by aindrive"). Used for nothing else.
import "server-only";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ed from "@noble/ed25519";
import { verifyMessage } from "viem";
import { fromHex, toHex } from "@/shared/willow/bytes";
import { issueAttestedCert, type Cert, type Trust } from "@/shared/willow/cert";
import { nowMicros } from "@/shared/willow/schemes";
import type { DeviceKeypair } from "@/shared/willow/keys";
import { dataDir } from "@/lib/db";

let cached: DeviceKeypair | null = null;

export function attestationKey(): DeviceKeypair {
  if (cached) return cached;
  const fromEnv = process.env.AINDRIVE_ATTESTATION_KEY?.trim();
  let secret: Uint8Array;
  if (fromEnv) secret = fromHex(fromEnv);
  else {
    const file = join(dataDir(), "attestation.key");
    if (existsSync(file)) secret = fromHex(readFileSync(file, "utf8").trim());
    else { secret = ed.utils.randomSecretKey(); writeFileSync(file, toHex(secret)); chmodSync(file, 0o600); }
  }
  if (secret.length !== 32) throw new Error("attestation key must be 32 bytes");
  cached = { secretKey: secret, publicKey: ed.getPublicKey(secret) };
  return cached;
}

export function trust(): Trust {
  return {
    attestationKeys: [toHex(attestationKey().publicKey)],
    verifyWallet: async (message, signature) => {
      const m = /^(0x[0-9a-fA-F]{40})$/m.exec(message);
      if (!m) return null;
      const ok = await verifyMessage({ address: m[1] as `0x${string}`, message, signature: signature as `0x${string}` }).catch(() => false);
      return ok ? m[1].toLowerCase() : null;
    },
  };
}

export async function certify(userId: string, deviceKeyHex: string, label: string): Promise<Cert> {
  const key = fromHex(deviceKeyHex);
  if (key.length !== 32) throw new Error("device key must be 32 bytes");
  return issueAttestedCert(attestationKey(), key, userId, label.slice(0, 80), nowMicros());
}
```

`ed.getPublicKey` (sync) needs `ed.hashes.sha512` set; add at the top of the file:
`import { sha512 } from "@noble/hashes/sha2.js"; ed.hashes.sha512 = sha512;`. If
`dataDir` is not exported from `web/lib/db.js`, export it (it is defined there at line 8).

```ts
// web/app/api/willow/cert/route.ts
import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { attestationKey, certify } from "@/lib/willow/attestation";
import { toHex } from "@/shared/willow/bytes";

/** POST { deviceKey, label } → an attested certificate binding this browser's device key to the signed-in user. */
export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "sign in" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { deviceKey?: unknown; label?: unknown };
  if (typeof body.deviceKey !== "string" || !/^[0-9a-f]{64}$/.test(body.deviceKey)) return NextResponse.json({ error: "deviceKey" }, { status: 400 });
  const cert = await certify(user.id, body.deviceKey, typeof body.label === "string" ? body.label : "browser");
  return NextResponse.json({ cert, attestationKey: toHex(attestationKey().publicKey) });
}
```

- [ ] **Step 4: Run the test until it passes**

Run: `cd web && npx vitest run lib/__tests__/willow-attestation.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add web/lib/willow/attestation.ts web/app/api/willow/cert/route.ts web/lib/__tests__/willow-attestation.test.ts web/lib/db.js
git commit -m "feat(willow): attestation key and /api/willow/cert"
```

---

### Task 4: Server peer — per-socket session with author + role check

**Files:**
- Create: `web/lib/willow/peer.ts`
- Modify: `web/server.js` (route `/api/willow/sync`)
- Test: `web/lib/__tests__/willow-peer.test.ts`

**Interfaces:**
- Consumes: `SyncSession`, `fullRange`, `Channel` (Task 1); `openDriveStore` (Task 2); `trust` (Task 3); `resolvePerson`, `Cert` (Plan 1 Task 2); `resolveRole`, `ROLE_RANK`, `paidAccessDenial` (existing: `web/lib/dochub.js` / `web/lib/sale-access.js` — import whatever `dochub.js` imports)
- Produces:
  - `acceptFor(driveId: string, store: AnyStore): (e: WireEntry) => Promise<string | null>` — `_id/cert` entries: the payload must parse as a `Cert` for this subspace that `resolvePerson` accepts; `doc/...` entries: the author (subspace) must resolve through certs in the store to a user whose role on the doc path is `editor` or above; anything else: `"outside-grant"`
  - `rangesFor(driveId, userId): Range3d[]` — the whole namespace for members; `[]` (no sync) when the drive has any paid path the user is not entitled to
  - `onWillowSync(ws, req, query): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
// web/lib/__tests__/willow-peer.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-peer-"));
const roles: Record<string, string> = { "u-ed": "editor", "u-view": "viewer" };
vi.mock("@/lib/willow/roles", () => ({ roleOf: (_d: string, u: string | null) => (u ? roles[u] ?? "none" : "none") }));
const { acceptFor } = await import("../willow/peer");
const { certify } = await import("../willow/attestation");
const { openDriveStore } = await import("../willow/store-node");
const { generateDeviceKey } = await import("@/shared/willow/keys");
const { toHex, pathOf, utf8 } = await import("@/shared/willow/bytes");
const { newStore } = await import("@/shared/willow/schemes");

async function signedDoc(kp: Awaited<ReturnType<typeof generateDeviceKey>>) {
  const s = newStore("d");
  const d = new Y.Doc(); d.getText("content").insert(0, "x");
  const r = await s.set({ path: pathOf(["doc", "a.md", "~u", "000000000001"]), subspace: kp.publicKey, payload: Y.encodeStateAsUpdate(d) }, kp);
  if (r.kind !== "success") throw new Error("setup");
  return { entry: r.entry, token: r.authToken, payload: Y.encodeStateAsUpdate(d) };
}

async function withCert(store: ReturnType<typeof openDriveStore>, userId: string) {
  const kp = await generateDeviceKey();
  const cert = await certify(userId, toHex(kp.publicKey), "t");
  const r = await store.set({ path: pathOf(["_id", "cert"]), subspace: kp.publicKey, payload: utf8(JSON.stringify(cert)) }, kp);
  if (r.kind !== "success") throw new Error("cert setup");
  return kp;
}

describe("server peer ingest check", () => {
  it("accepts an editor's doc entry", async () => {
    const store = openDriveStore("d", process.env.AINDRIVE_DATA_DIR!);
    const kp = await withCert(store, "u-ed");
    expect(await acceptFor("d", store)(await signedDoc(kp))).toBeNull();
  });
  it("refuses a viewer's doc entry", async () => {
    const store = openDriveStore("d", process.env.AINDRIVE_DATA_DIR!);
    const kp = await withCert(store, "u-view");
    expect(await acceptFor("d", store)(await signedDoc(kp))).toBe("not-a-member");
  });
  it("refuses a doc entry from a device with no certificate", async () => {
    const store = openDriveStore("d", process.env.AINDRIVE_DATA_DIR!);
    expect(await acceptFor("d", store)(await signedDoc(await generateDeviceKey()))).toBe("unknown-device");
  });
  it("refuses a cert entry naming another device key", async () => {
    const store = openDriveStore("d", process.env.AINDRIVE_DATA_DIR!);
    const kp = await generateDeviceKey();
    const other = await generateDeviceKey();
    const cert = await certify("u-ed", toHex(other.publicKey), "t");
    const s = newStore("d");
    const r = await s.set({ path: pathOf(["_id", "cert"]), subspace: kp.publicKey, payload: utf8(JSON.stringify(cert)) }, kp);
    if (r.kind !== "success") throw new Error("setup");
    expect(await acceptFor("d", store)({ entry: r.entry, token: r.authToken, payload: utf8(JSON.stringify(cert)) })).toBe("bad-cert");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd web && npx vitest run lib/__tests__/willow-peer.test.ts`
Expected: FAIL: `Cannot find module '../willow/peer'`.

- [ ] **Step 3: Write `roles.ts` (a seam over the existing role logic) and `peer.ts`**

```ts
// web/lib/willow/roles.ts
// The one question the peer asks the rest of the app: this user's role on this path.
// Same rule as dochub/access (owner, else a covering drive_members row).
import "server-only";
import { resolveRole } from "@/lib/dochub.js";
export const roleOf = (driveId: string, userId: string | null, path: string): string => resolveRole(driveId, userId, path);
```

If `resolveRole` is not exported from `web/lib/dochub.js`, export it (it is defined
there; `onDocConnect` calls it).

```ts
// web/lib/willow/peer.ts
// The server as one Willow peer (spec §6): a store per drive, one SyncSession per
// socket. At ingest it checks, for every entry from any device: the signature
// (the store's scheme), who the device is (certificates in the store), and that
// person's role on the path — the same rule the HTTP routes use.
import "server-only";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { partsOf, toHex } from "@/shared/willow/bytes";
import { resolvePerson, certsFrom, type Cert } from "@/shared/willow/cert";
import { mayWrite } from "@/shared/willow/policy";
import { clientClaimConflict } from "@/shared/willow/doc";
import { nowMicros } from "@/shared/willow/schemes";
import { SyncSession, fullRange } from "@/shared/willow/session";
import type { AnyStore } from "@/shared/willow/doc";
import type { WireEntry } from "@/shared/willow/wire";
import { dataDir } from "@/lib/db";
import { openDriveStore } from "./store-node";
import { trust } from "./attestation";
import { roleOf } from "./roles";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const RANK: Record<string, number> = { none: 0, viewer: 1, commenter: 2, editor: 3, owner: 4 };
const WRITE = RANK.editor;

async function certsIn(store: AnyStore): Promise<Cert[]> {
  const raw: { subspaceHex: string; payload: Uint8Array }[] = [];
  const enc = new TextEncoder();
  for await (const [entry, payload] of store.queryRange({ ...fullRange(), pathRange: { start: [enc.encode("_id")], end: [enc.encode("_id\u0000")] } }, "oldest")) {
    if (partsOf(entry.path)[1] !== "cert" || !payload) continue;
    raw.push({ subspaceHex: toHex(entry.subspaceId), payload: await payload.bytes() });
  }
  return certsFrom(raw); // shape-checked, and only certs in their own device's subspace (review I4)
}

export function acceptFor(driveId: string, store: AnyStore) {
  return async (w: WireEntry): Promise<string | null> => {
    const parts = partsOf(w.entry.path);
    const subspace = toHex(w.entry.subspaceId);
    const now = nowMicros();
    if (parts[0] === "_id") {
      let cert: Cert | undefined;
      if (parts[1] === "cert") {
        const parsed = certsFrom([{ subspaceHex: subspace, payload: w.payload ?? new Uint8Array() }]);
        if (!parsed.length) return "bad-cert";
        cert = parsed[0];
      }
      const v = await mayWrite({ subspaceHex: subspace, path: parts, timestamp: w.entry.timestamp, payloadLength: w.entry.payloadLength, cert },
        { driveId, ownerUserId: "", grants: [], certs: await certsIn(store), revocations: [], trust: trust(), now });
      return v.ok ? null : v.reason === "unknown-device" && parts[1] === "cert" ? "bad-cert" : v.reason;
    }
    if (parts[0] !== "doc") return "outside-grant";
    const person = await resolvePerson(subspace, await certsIn(store), [], trust(), now > w.entry.timestamp ? now : w.entry.timestamp);
    if (!person) return "unknown-device";
    const u = parts.indexOf("~u");
    const docPath = parts.slice(1, u < 0 ? parts.length : u);
    if ((RANK[roleOf(driveId, person.userId, docPath.join("/"))] ?? 0) < WRITE) return "not-a-member";
    if (w.payload && (await clientClaimConflict(store, docPath, subspace, w.payload))) return "client-id-taken"; // review I5
    return null;
  };
}

export function storeDir() {
  const dir = join(dataDir(), "willow");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** WS /api/willow/sync?drive=<id> — one sync session for a signed-in member. */
export async function onWillowSync(ws: WebSocket, _req: IncomingMessage, query: Record<string, unknown>, userId: string | null) {
  const driveId = String(query.drive ?? "");
  if (!driveId || (RANK[roleOf(driveId, userId, "")] ?? 0) < RANK.viewer) { ws.close(4401, "no access"); return; }
  const store = openDriveStore(driveId, storeDir());
  const listeners: ((f: never) => void)[] = [];
  const closers: (() => void)[] = [];
  ws.on("message", (data) => { let f; try { f = JSON.parse(data.toString("utf8")); } catch { return; } for (const cb of listeners) cb(f as never); });
  ws.on("close", () => closers.forEach((c) => c()));
  const session = new SyncSession({
    store,
    ranges: [fullRange()],
    accept: acceptFor(driveId, store),
    channel: {
      send: (f) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(f)); },
      onFrame: (cb) => listeners.push(cb as never),
      onClose: (cb) => closers.push(cb),
    },
  });
  await session.start();
}
```

Paid paths: `rangesFor` is folded into `onWillowSync`'s access check for Phase 1 —
before `new SyncSession`, if `paidAccessDenial` would deny this user any path of the
drive, close with `4402`. Find the drive's paid paths the way `sale-access.js` does
(`paidLocksForPaths` / the sales table) and call `paidAccessDenial(driveId, path, role, userId)`
for each; on any denial, `ws.close(4402, "payment required")` and return. Add a test
case to Step 1's file that mocks one paid path and expects close code 4402.

- [ ] **Step 4: Route the socket in `web/server.js`**

Add next to the `/api/agent/doc` branch (and the import at the top):

```js
import { onWillowSync } from "./lib/willow/peer.ts";
import { readUserFromCookie } from "./lib/dochub.js";
// ...
  if (pathname === "/api/willow/sync") {
    wss.handleUpgrade(req, socket, head, async (ws) => {
      try {
        const userId = await readUserFromCookie(req.headers["cookie"]);
        await onWillowSync(ws, req, query, userId);
      } catch (e) {
        log.error({ err: e?.message || String(e) }, "willow sync error");
        try { ws.close(1011, "internal error"); } catch {}
      }
    });
    return;
  }
```

Match how `server.js` already imports TS from `lib/` (look at how `onDocConnect`
and `onAgentConnect` are imported; if `server.js` cannot import `.ts`, export
`onWillowSync` through the same bundling path the others use, or write `peer` as
`.js` with JSDoc types like `dochub.js`). Export `readUserFromCookie` from
`dochub.js` if it is private.

- [ ] **Step 5: Run the tests until they pass**

Run: `cd web && npx vitest run lib/__tests__/willow-peer.test.ts`
Expected: 5 passed (4 + the paid-path case).

- [ ] **Step 6: Commit**

```bash
git add web/lib/willow/peer.ts web/lib/willow/roles.ts web/server.js web/lib/dochub.js web/lib/__tests__/willow-peer.test.ts
git commit -m "feat(willow): server peer — /api/willow/sync with author and role check"
```

---

### Task 5: The Yjs binding and the browser client

**Files:**
- Create: `web/shared/willow/y-binding.ts`, `web/lib/willow/client.ts`
- Test: `web/lib/__tests__/willow-binding.test.ts`

**Interfaces:**
- Consumes: `appendUpdate`, `readUpdates`, `authorsByClient`, `AnyStore` (Plan 1 Task 4); `SyncSession` (Task 1); `DeviceKeypair`, `generateDeviceKey` (Plan 1)
- Produces:
  - `y-binding.ts`: `bindDoc(o: { store: AnyStore; key: DeviceKeypair; docPath: string[]; doc: Y.Doc; nextSeq(): Promise<number> }): Promise<() => void>` — loads every stored update into `doc`, then: local `doc` updates → `appendUpdate` (origin ≠ the binding); store entries for this doc from elsewhere → `Y.applyUpdate(doc, u, binding)`; returns an unbind function. `clientIdFor(key: DeviceKeypair, tab: number): number` — a uint32 from the key and a per-tab counter (Review Focus 3).
  - `client.ts` (browser only): `willowClient(driveId: string): Promise<{ store; key; openDoc(docPath: string[], doc: Y.Doc): Promise<() => void>; status: EventTarget /* "online" | "offline" | "refused" */ }>`

- [ ] **Step 1: Write the failing test**

```ts
// web/lib/__tests__/willow-binding.test.ts
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { generateDeviceKey } from "@/shared/willow/keys";
import { newStore } from "@/shared/willow/schemes";
import { SyncSession, fullRange, type Channel } from "@/shared/willow/session";
import { bindDoc, clientIdFor } from "@/shared/willow/y-binding";
import type { Frame } from "@/shared/willow/wire";

function pipe(): [Channel, Channel] {
  const a = { f: [] as ((x: Frame) => void)[] }, b = { f: [] as ((x: Frame) => void)[] };
  const c = (me: typeof a, o: typeof a): Channel => ({ send: (x) => queueMicrotask(() => o.f.forEach((cb) => cb(JSON.parse(JSON.stringify(x))))), onFrame: (cb) => me.f.push(cb), onClose: () => {} });
  return [c(a, b), c(b, a)];
}
const settle = () => new Promise((r) => setTimeout(r, 60));
let seq = 0;
const nextSeq = async () => ++seq;

describe("Y.Doc bound to a Willow store", () => {
  it("typing in one browser shows up in another through the stores", async () => {
    const k1 = await generateDeviceKey(), k2 = await generateDeviceKey();
    const s1 = newStore("d"), s2 = newStore("d");
    const [c1, c2] = pipe();
    await Promise.all([new SyncSession({ store: s1, channel: c1, ranges: [fullRange()] }).start(), new SyncSession({ store: s2, channel: c2, ranges: [fullRange()] }).start()]);
    const d1 = new Y.Doc(), d2 = new Y.Doc();
    await bindDoc({ store: s1, key: k1, docPath: ["a.md"], doc: d1, nextSeq });
    await bindDoc({ store: s2, key: k2, docPath: ["a.md"], doc: d2, nextSeq });
    d1.getText("content").insert(0, "hello ");
    await settle();
    d2.getText("content").insert(d2.getText("content").length, "world");
    await settle();
    expect(d1.getText("content").toString()).toBe("hello world");
    expect(d2.getText("content").toString()).toBe("hello world");
  });

  it("a reopened doc has everything typed before, with no network", async () => {
    const k = await generateDeviceKey();
    const s = newStore("d");
    const d1 = new Y.Doc();
    const unbind = await bindDoc({ store: s, key: k, docPath: ["a.md"], doc: d1, nextSeq });
    d1.getText("content").insert(0, "offline text");
    await settle();
    unbind();
    const d2 = new Y.Doc();
    await bindDoc({ store: s, key: k, docPath: ["a.md"], doc: d2, nextSeq });
    expect(d2.getText("content").toString()).toBe("offline text");
  });

  it("two tabs of one device get different Yjs client ids", async () => {
    const k = await generateDeviceKey();
    expect(clientIdFor(k, 1)).not.toBe(clientIdFor(k, 2));
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd web && npx vitest run lib/__tests__/willow-binding.test.ts`
Expected: FAIL: `Cannot find module '@/shared/willow/y-binding'`.

- [ ] **Step 3: Write `y-binding.ts`**

```ts
// web/shared/willow/y-binding.ts
// A Y.Doc bound to a Willow store (spec §7): every local change becomes a signed
// entry; every entry for this document that reaches the store from elsewhere (sync,
// another tab) is applied to the doc. The store is the only persistence.
import * as Y from "yjs";
import { partsOf } from "./bytes";
import { appendUpdate, readUpdates, type AnyStore } from "./doc";
import type { DeviceKeypair } from "./keys";

export function clientIdFor(key: DeviceKeypair, tab: number): number {
  const k = key.publicKey;
  return (((k[0] << 24) | (k[1] << 16) | (k[2] << 8) | k[3]) ^ Math.imul(tab, 0x9e3779b1)) >>> 0;
}

export async function bindDoc(o: { store: AnyStore; key: DeviceKeypair; docPath: string[]; doc: Y.Doc; nextSeq(): Promise<number> }): Promise<() => void> {
  const origin = Symbol("willow");
  for (const u of await readUpdates(o.store, o.docPath)) Y.applyUpdate(o.doc, u.update, origin);

  const onLocal = (update: Uint8Array, from: unknown) => {
    if (from === origin) return;
    void (async () => appendUpdate(o.store, o.key, o.docPath, update, await o.nextSeq()))();
  };
  o.doc.on("update", onLocal);

  const isThisDoc = (path: Uint8Array[]) => {
    const p = partsOf(path);
    return p[0] === "doc" && p.length >= o.docPath.length + 2 && o.docPath.every((c, i) => p[i + 1] === c) && p[o.docPath.length + 1] === "~u" && p.length <= o.docPath.length + 3;
  };
  const onEntry = async (ev: Event) => {
    const { entry } = (ev as CustomEvent<{ entry: { path: Uint8Array[]; subspaceId: Uint8Array } }>).detail;
    if (!isThisDoc(entry.path)) return;
    const payload = await o.store.getPayload?.(entry.subspaceId, entry.path);
    if (payload) Y.applyUpdate(o.doc, await payload.bytes(), origin);
  };
  // payloadingest = arrived by sync; entrypayloadset = written by another binding (another tab) on this store
  o.store.addEventListener("payloadingest", onEntry);
  o.store.addEventListener("entrypayloadset", onEntry);
  return () => {
    o.doc.off("update", onLocal);
    o.store.removeEventListener("payloadingest", onEntry);
    o.store.removeEventListener("entrypayloadset", onEntry);
  };
}
```

Applying our own entry back (the `entrypayloadset` from our own `appendUpdate`) is
harmless: Yjs ignores updates it already has.

- [ ] **Step 4: Run the test until it passes**

Run: `cd web && npx vitest run lib/__tests__/willow-binding.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Write the browser client**

```ts
// web/lib/willow/client.ts
// The browser's Willow peer (spec §6): a device key and store in IndexedDB, a
// certificate from /api/willow/cert, and a sync session to /api/willow/sync that
// reconnects with backoff. Offline, edits go to the store and sync on reconnect.
"use client";
import { KvDriverIndexedDB, PayloadDriverIndexedDb, Store, EntryDriverKvStore } from "@earthstar/willow";
import * as Y from "yjs";
import { aindriveSchemes, namespaceOf } from "@/shared/willow/schemes";
import { generateDeviceKey, type DeviceKeypair } from "@/shared/willow/keys";
import { fromHex, pathOf, toHex, utf8 } from "@/shared/willow/bytes";
import { SyncSession, fullRange } from "@/shared/willow/session";
import { bindDoc, clientIdFor } from "@/shared/willow/y-binding";
import type { AnyStore } from "@/shared/willow/doc";
import type { Frame } from "@/shared/willow/wire";

const KEY_DB = "aindrive-device";

async function idb<T>(fn: (os: IDBObjectStore) => IDBRequest<T>, mode: IDBTransactionMode = "readonly"): Promise<T> {
  const db = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open(KEY_DB, 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return new Promise((res, rej) => { const req = fn(db.transaction("kv", mode).objectStore("kv")); req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
}

export async function deviceKey(): Promise<DeviceKeypair> {
  const hit = await idb<{ s: string; p: string } | undefined>((os) => os.get("key"));
  if (hit) return { secretKey: fromHex(hit.s), publicKey: fromHex(hit.p) };
  const kp = await generateDeviceKey();
  await idb((os) => os.put({ s: toHex(kp.secretKey), p: toHex(kp.publicKey) }, "key"), "readwrite");
  return kp;
}

let tabCounter = 0;
const clients = new Map<string, ReturnType<typeof connect>>();

export function willowClient(driveId: string) {
  let c = clients.get(driveId);
  if (!c) { c = connect(driveId); clients.set(driveId, c); }
  return c;
}

async function connect(driveId: string) {
  const key = await deviceKey();
  const kv = new KvDriverIndexedDB(`aindrive-willow-${driveId}`);
  const payloadDriver = new PayloadDriverIndexedDb(`aindrive-willow-payloads-${driveId}`, aindriveSchemes.payload);
  const store = new Store({
    namespace: namespaceOf(driveId), schemes: aindriveSchemes, payloadDriver,
    entryDriver: new EntryDriverKvStore({ kvDriver: kv, namespaceScheme: aindriveSchemes.namespace, subspaceScheme: aindriveSchemes.subspace, payloadScheme: aindriveSchemes.payload, pathScheme: aindriveSchemes.path, fingerprintScheme: aindriveSchemes.fingerprint, getPayloadLength: (d) => payloadDriver.length(d) }),
  }) as AnyStore;
  const status = new EventTarget();

  // my certificate, once per device; stored as an entry so it syncs with my edits
  const certPath = pathOf(["_id", "cert"]);
  if (!(await store.getPayload?.(key.publicKey, certPath))) {
    const r = await fetch("/api/willow/cert", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceKey: toHex(key.publicKey), label: navigator.userAgent.slice(0, 60) }) }).catch(() => null);
    if (r?.ok) { const { cert } = await r.json(); await store.set({ path: certPath, subspace: key.publicKey, payload: utf8(JSON.stringify(cert)) }, key); }
  }

  // sequence numbers: device-wide, persisted, never reused (two tabs share the device key)
  const nextSeq = async () => {
    const n = ((await idb<number | undefined>((os) => os.get(`seq-${driveId}`))) ?? 0) + 1;
    await idb((os) => os.put(n, `seq-${driveId}`), "readwrite");
    return Date.now() * 1000 + (n % 1000); // monotonic across tabs even if two read the same n
  };

  let backoff = 500;
  const open = () => {
    const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/api/willow/sync?drive=${encodeURIComponent(driveId)}`);
    const frames: ((f: Frame) => void)[] = [], closes: (() => void)[] = [];
    ws.onmessage = (ev) => { try { const f = JSON.parse(String(ev.data)); frames.forEach((cb) => cb(f)); } catch {} };
    ws.onopen = () => {
      backoff = 500;
      status.dispatchEvent(new Event("online"));
      void new SyncSession({
        store, ranges: [fullRange()],
        channel: { send: (f) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(f)), onFrame: (cb) => frames.push(cb), onClose: (cb) => closes.push(cb) },
        onRefused: (f) => status.dispatchEvent(new CustomEvent("refused", { detail: f })),
      }).start();
    };
    ws.onclose = (ev) => {
      closes.forEach((c) => c());
      status.dispatchEvent(new Event("offline"));
      if (ev.code === 4401 || ev.code === 4402) return; // no access: do not hammer
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 15_000);
    };
  };
  open();

  return {
    store, key, status,
    openDoc: (docPath: string[], doc: Y.Doc) => { doc.clientID = clientIdFor(key, ++tabCounter + Math.floor(Math.random() * 1e6)); return bindDoc({ store, key, docPath, doc, nextSeq }); },
  };
}
```

`nextSeq` returns a microsecond-based number so two tabs of the same device never
reuse a path (Review Focus 3). Update the Interfaces note in Task 5 accordingly.
If the IndexedDB drivers are exported under different names, check
`node_modules/@earthstar/willow/mod.browser.ts` and use those.

- [ ] **Step 6: Commit**

```bash
git add web/shared/willow/y-binding.ts web/lib/willow/client.ts web/lib/__tests__/willow-binding.test.ts
git commit -m "feat(willow): Yjs binding and the browser client"
```

---

### Task 6: Editors use the binding; offline open

**Files:**
- Modify: `web/lib/yjs/aindrive-provider.ts` (content persistence off; awareness stays), `web/components/editors/rich-text-editor.tsx`, `web/components/viewer.tsx`
- Create: `web/public/sw.js`, `web/lib/willow/offline.ts`
- Test: `web/e2e/willow-offline.spec.ts` (Playwright)

**Interfaces:**
- Consumes: `willowClient(driveId).openDoc(docPath, doc)` (Task 5)
- Produces: `registerOffline(): void` (registers `/sw.js` once)

- [ ] **Step 1: Write the failing E2E test**

```ts
// web/e2e/willow-offline.spec.ts
import { test, expect } from "@playwright/test";

// Needs a dev server with a signed-in owner and one drive with a.md whose agent is
// online: reuse the fixtures the existing e2e setup uses (see web/e2e/ and
// playwright.config.ts for the login helper and drive seed).
test("edit offline, reload, reconnect: the text stays and reaches a second browser", async ({ browser }) => {
  const a = await browser.newContext({ storageState: "e2e/.auth/owner.json" });
  const pa = await a.newPage();
  await pa.goto(process.env.E2E_DOC_URL!);
  const editor = pa.locator(".ProseMirror");
  await editor.click();
  await a.setOffline(true);
  await pa.keyboard.type(" offline-edit-1");
  await pa.reload().catch(() => {}); // served by the service worker
  await expect(pa.locator(".ProseMirror")).toContainText("offline-edit-1");
  await a.setOffline(false);
  const b = await browser.newContext({ storageState: "e2e/.auth/owner.json" });
  const pb = await b.newPage();
  await pb.goto(process.env.E2E_DOC_URL!);
  await expect(pb.locator(".ProseMirror")).toContainText("offline-edit-1", { timeout: 15_000 });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd web && npx playwright test e2e/willow-offline.spec.ts`
Expected: FAIL (the reload offline shows the browser's offline page, or the text is gone).

- [ ] **Step 3: Switch the editors to the binding**

In `rich-text-editor.tsx` and `viewer.tsx`, where the Y.Doc is created for a file:
1. After creating the doc, call `const unbind = await willowClient(driveId).openDoc(path.split("/"), doc)` and call `unbind()` in the cleanup.
2. Delete the autosave's `POST /yjs` call and the `GET /yjs` seed (`viewer.tsx:158-172`); keep `fs/write` until Plan 3's agent materialises the file (comment it: `// until Plan 3: the agent writes the file`).
3. The rich-text editor seeds from markdown only when the store has no updates for the doc (`(await readUpdates(store, docPath)).length === 0`), and then writes the seed as one update.

In `aindrive-provider.ts`: remove `IndexeddbPersistence` and the `sync` frame handling;
keep `aware` frames. `whenReady` resolves after `openDoc`.

- [ ] **Step 4: The service worker**

```js
// web/public/sw.js
// Offline open (spec §7): the app shell and every drive page visited are cached;
// documents come from the Willow store in IndexedDB, so a cached page is enough.
const CACHE = "aindrive-shell-v1";
self.addEventListener("install", (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  const cacheable = req.mode === "navigate" || url.pathname.startsWith("/_next/static/");
  if (!cacheable) return;
  e.respondWith(
    fetch(req)
      .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; })
      .catch(async () => (await caches.match(req)) ?? (await caches.match("/")) ?? Response.error()),
  );
});
```

```ts
// web/lib/willow/offline.ts
"use client";
let done = false;
export function registerOffline() {
  if (done || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  done = true;
  void navigator.serviceWorker.register("/sw.js").catch(() => {});
}
```

Call `registerOffline()` from the drive shell's top-level client component
(`web/components/drive-shell.tsx`, in its first `useEffect`).

- [ ] **Step 5: Run the E2E test until it passes**

Run: `cd web && npx playwright test e2e/willow-offline.spec.ts`
Expected: 1 passed.

- [ ] **Step 6: Run the unit suite**

Run: `cd web && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add web/lib/yjs/aindrive-provider.ts web/components/editors/rich-text-editor.tsx web/components/viewer.tsx web/public/sw.js web/lib/willow/offline.ts web/components/drive-shell.tsx web/e2e/willow-offline.spec.ts
git commit -m "feat(willow): editors on the Willow binding; offline open via service worker"
```

---

### Task 7: Who wrote this, and the spec amendments

**Files:**
- Create: `web/components/editors/authorship.ts`
- Modify: `web/components/editors/rich-text-editor.tsx` (hover/selection label), `docs/superpowers/specs/2026-09-26-willow-local-first-docs-design.md` (§3 D4/D7, §11), `web/lib/README.md`
- Test: `web/lib/__tests__/willow-authorship.test.ts`

**Interfaces:**
- Consumes: `authorsByClient` (Plan 1 Task 4), `resolvePerson` (Plan 1 Task 2), certificates in the store (Task 4's `certsIn` — move it to `web/shared/willow/doc.ts` as `certsIn(store)`)
- Produces: `authorAt(doc: Y.Doc, index: number, authors: Map<number, string>): string | null` (the device key hex that inserted the character at `index` of `Y.Text("content")`), `labelFor(deviceHex, certs, trust, names: Map<string,string>): Promise<string>` → `"Mom · vouched by aindrive"` / `"Mom · wallet"` / `"unknown device"`

- [ ] **Step 1: Write the failing test**

```ts
// web/lib/__tests__/willow-authorship.test.ts
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { authorAt } from "@/components/editors/authorship";

describe("authorAt", () => {
  it("names the device that typed each character", () => {
    const a = new Y.Doc(); a.clientID = 1; a.getText("content").insert(0, "mom ");
    const b = new Y.Doc(); b.clientID = 2; Y.applyUpdate(b, Y.encodeStateAsUpdate(a)); b.getText("content").insert(4, "kid");
    const authors = new Map([[1, "aa"], [2, "bb"]]);
    expect(authorAt(b, 0, authors)).toBe("aa");
    expect(authorAt(b, 5, authors)).toBe("bb");
    expect(authorAt(b, 99, authors)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd web && npx vitest run lib/__tests__/willow-authorship.test.ts`
Expected: FAIL: `Cannot find module '@/components/editors/authorship'`.

- [ ] **Step 3: Write `authorship.ts`**

```ts
// web/components/editors/authorship.ts
// "Who wrote this" (spec §6): the Yjs item under a character carries the clientID
// of the device session that typed it; authorsByClient maps that to the signed
// device key; the device's certificate names the person.
import * as Y from "yjs";
import { resolvePerson, type Cert, type Trust } from "@/shared/willow/cert";

export function authorAt(doc: Y.Doc, index: number, authors: Map<number, string>): string | null {
  let pos = 0;
  let item = doc.getText("content")._start;
  while (item) {
    if (!item.deleted && item.countable) {
      if (index < pos + item.length) return authors.get(item.id.client) ?? null;
      pos += item.length;
    }
    item = item.right;
  }
  return null;
}

export async function labelFor(deviceHex: string, certs: Cert[], trust: Trust, names: Map<string, string>): Promise<string> {
  const p = await resolvePerson(deviceHex, certs, [], trust);
  if (!p) return "unknown device";
  return `${names.get(p.userId) ?? p.userId} · ${p.strength === "wallet" ? "wallet" : "vouched by aindrive"}`;
}
```

For the rich-text editor (`XmlFragment("prosemirror")`), walk the ProseMirror
position to the Yjs item with `y-prosemirror`'s `absolutePositionToRelativePosition`,
then read `relPos.item.client` and map it through `authors`. Show the label in a small
tooltip on text selection (reuse the editor's existing bubble menu component).

- [ ] **Step 4: Run the test until it passes**

Run: `cd web && npx vitest run lib/__tests__/willow-authorship.test.ts`
Expected: 1 passed.

- [ ] **Step 5: Amend the spec** — §3 D7: "Sync is 3D range-based set reconciliation
  (the algorithm WGPS uses) plus live push; `WgpsMessenger` in @earthstar/willow 0.6
  reconciles only at session start." §3 D4 and §11: "In Phase 1 the server peer is the
  only path between devices and enforces membership with the web app's role rule;
  owner-signed `_acl` grants and client-side `mayWrite` ship with Phase 2." §4: "The
  browser keeps its device key as raw bytes in IndexedDB in Phase 1."
  Add `willow/` lines to `web/lib/README.md`'s file map.

- [ ] **Step 6: Commit**

```bash
git add web/components/editors/authorship.ts web/components/editors/rich-text-editor.tsx web/lib/__tests__/willow-authorship.test.ts docs/superpowers/specs/2026-09-26-willow-local-first-docs-design.md web/lib/README.md
git commit -m "feat(willow): who wrote this; spec amended for Phase 1 sync and membership"
```
