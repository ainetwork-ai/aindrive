// web/lib/willow/peer.ts
// The server as one Willow peer (spec §6): a store per drive, one SyncSession per
// socket. At ingest it checks, for every entry from any device: the signature
// (the store's scheme), who the device is (certificates in the store), and that
// person's role on the path — the same rule the HTTP routes use.
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { partsOf, toHex } from "@/shared/willow/bytes";
import { resolvePerson, certsFrom, type Cert } from "@/shared/willow/cert";
import { mayWrite } from "@/shared/willow/policy";
import { authorsByClient, certsIn, revocationsIn } from "@/shared/willow/doc";
import type { Revocation } from "@/shared/willow/cert";
import type { Entry } from "@jsr/earthstar__willow-utils";
import * as Y from "yjs";
import { nowMicros } from "@/shared/willow/schemes";
import { SyncSession, fullRange } from "@/shared/willow/session";
import type { AnyStore } from "@/shared/willow/doc";
import type { WireEntry } from "@/shared/willow/wire";
import { dataDir } from "@/lib/env";
import { openDriveStore } from "./store-node";
import { trust } from "./attestation";
import { roleOf, isMember, paywalled } from "./roles";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const RANK: Record<string, number> = { none: 0, viewer: 1, commenter: 2, editor: 3, owner: 4 };
const WRITE = RANK.editor;

// Per-store caches (review I5): certificates and revocations change only when an
// _id entry is accepted; a document's client→author map grows by one entry at a time.
type Cache = { certs?: Cert[]; revs?: Revocation[]; authors: Map<string, Map<number, string>> };
const caches = new WeakMap<AnyStore, Cache>();
function cacheOf(store: AnyStore): Cache {
  let c = caches.get(store);
  if (!c) {
    const fresh: Cache = { authors: new Map() };
    // any new entry, from sync or written here: drop what it could change
    const onEntry = async (ev: Event) => {
      const { entry, payload } = (ev as CustomEvent<{ entry: Entry<Uint8Array, Uint8Array, Uint8Array>; payload?: { bytes(): Promise<Uint8Array> } }>).detail;
      const parts = partsOf(entry.path);
      if (parts[0] === "_id") { fresh.certs = undefined; fresh.revs = undefined; return; }
      if (parts[0] !== "doc" || !payload) return;
      // first claim wins: add this update's clients to the document's map, if it is cached
      const m = fresh.authors.get(parts.slice(1, parts.indexOf("~u")).join("/"));
      if (!m) return;
      const who = toHex(entry.subspaceId);
      for (const c of clientsOf(await payload.bytes())) if (!m.has(c)) m.set(c, who);
    };
    for (const name of ["entryingest", "entrypayloadset", "payloadingest"]) store.addEventListener(name, onEntry);
    c = fresh;
    caches.set(store, c);
  }
  return c;
}
const certsCached = async (store: AnyStore) => (cacheOf(store).certs ??= await certsIn(store));
const revsCached = async (store: AnyStore) => (cacheOf(store).revs ??= await revocationsIn(store));
async function authorsCached(store: AnyStore, docPath: string[]) {
  const c = cacheOf(store), k = docPath.join("/");
  let m = c.authors.get(k);
  if (!m) { m = await authorsByClient(store, docPath); c.authors.set(k, m); }
  return m;
}
const clientsOf = (update: Uint8Array): number[] => { try { return [...new Set(Y.decodeUpdate(update).structs.map((x) => x.id.client))]; } catch { return []; } };

export function acceptFor(driveId: string, store: AnyStore) {
  return async (w: WireEntry): Promise<string | null> => {
    const parts = partsOf(w.entry.path);
    const subspace = toHex(w.entry.subspaceId);
    const now = nowMicros();
    const certs = await certsCached(store), revs = await revsCached(store);
    if (parts[0] === "_id") {
      if (parts[1] === "revoke") {
        // a client may upload only its own device's retirement (aindrive's revocations are written by the server)
        let r: Revocation;
        try { r = JSON.parse(new TextDecoder().decode(w.payload ?? new Uint8Array())) as Revocation; } catch { return "bad-revocation"; }
        if (parts.length !== 3 || r.deviceKey !== subspace || r.by !== subspace || parts[2] !== subspace) return "bad-revocation";
        const at = BigInt(/^[0-9]{1,20}$/.test(String(r.at)) ? r.at : "0");
        const before = await resolvePerson(subspace, certs, revs, trust(), at);
        const after = await resolvePerson(subspace, certs, [...revs, r], trust(), at);
        if (!before || after) return "bad-revocation"; // unknown device, or the revocation does not verify
        return null;
      }
      let cert: Cert | undefined;
      if (parts[1] === "cert") {
        const parsed = certsFrom([{ subspaceHex: subspace, payload: w.payload ?? new Uint8Array() }]);
        if (!parsed.length) return "bad-cert";
        cert = parsed[0];
      }
      const v = await mayWrite({ subspaceHex: subspace, path: parts, timestamp: w.entry.timestamp, payloadLength: w.entry.payloadLength, cert },
        { driveId, ownerUserId: "", grants: [], certs, revocations: revs, trust: trust(), now });
      if (!v.ok) return v.reason === "unknown-device" && parts[1] === "cert" ? "bad-cert" : v.reason;
      return null;
    }
    if (parts[0] !== "doc") return "outside-grant";
    const u = parts.indexOf("~u");
    if (u < 2 || parts.length > u + 2) return "outside-grant";
    const person = await resolvePerson(subspace, certs, revs, trust(), now > w.entry.timestamp ? now : w.entry.timestamp);
    if (!person) return "unknown-device";
    const docPath = parts.slice(1, u);
    if ((RANK[roleOf(driveId, person.userId, docPath.join("/"))] ?? 0) < WRITE) return "not-a-member";
    if (w.payload) {
      const owners = await authorsCached(store, docPath);
      const clients = clientsOf(w.payload);
      if (clients.some((c) => owners.has(c) && owners.get(c) !== subspace)) return "client-id-taken"; // review I5
    }
    return null;
  };
}

/** What the server may send this user, per entry, at send time (review C3/I4):
 *  certificates and revocations always (authorship needs them); a document only
 *  if the user may read its path now and it is not behind a paywall for them. */
export function allowFor(driveId: string, userId: string | null) {
  return (e: Pick<Entry<Uint8Array, Uint8Array, Uint8Array>, "path">): boolean => {
    const parts = partsOf(e.path);
    if (parts[0] === "_id") return true;
    if (parts[0] !== "doc") return false;
    const u = parts.indexOf("~u");
    const path = parts.slice(1, u < 0 ? parts.length : u).join("/");
    return (RANK[roleOf(driveId, userId, path)] ?? 0) >= RANK.viewer && !paywalled(driveId, userId, path);
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
  if (!driveId || !isMember(driveId, userId)) { ws.close(4401, "no access"); return; }
  const store = openDriveStore(driveId, storeDir());
  const listeners: ((f: never) => void)[] = [];
  const closers: (() => void)[] = [];
  ws.on("message", (data) => { let f; try { f = JSON.parse(data.toString("utf8")); } catch { return; } for (const cb of listeners) cb(f as never); });
  ws.on("close", () => closers.forEach((c) => c()));
  const session = new SyncSession({
    store,
    ranges: [fullRange()],
    accept: acceptFor(driveId, store),
    allow: allowFor(driveId, userId),
    channel: {
      send: (f) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(f)); },
      onFrame: (cb) => listeners.push(cb as never),
      onClose: (cb) => closers.push(cb),
    },
  });
  await session.start();
}
