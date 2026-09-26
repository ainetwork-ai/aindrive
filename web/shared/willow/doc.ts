// web/shared/willow/doc.ts
// A collaborative document is the union of the Yjs updates for its path across all
// subspaces (spec D5). Each update is one entry signed by its device; a device may
// fold its own updates into one snapshot at ["doc",...path,"~u"], which prunes its
// older ["doc",...path,"~u",seq] entries (Willow prefix pruning, same subspace only).
import * as Y from "yjs";
import { ANY_SUBSPACE, OPEN_END, type Area } from "@jsr/earthstar__willow-utils";
import { pathOf, partsOf, toHex } from "./bytes";
import { nowMicros, type newStore } from "./schemes";
import type { DeviceKeypair } from "./keys";

export type AnyStore = ReturnType<typeof newStore>;

export const snapshotPath = (docPath: string[]) => pathOf(["doc", ...docPath, "~u"]);
export const updatePath = (docPath: string[], seq: number) => pathOf(["doc", ...docPath, "~u", String(seq).padStart(12, "0")]);

export async function appendUpdate(store: AnyStore, kp: DeviceKeypair, docPath: string[], update: Uint8Array, seq: number, timestamp = nowMicros()): Promise<void> {
  const r = await store.set({ path: updatePath(docPath, seq), subspace: kp.publicKey, payload: update, timestamp }, kp);
  if (r.kind !== "success") throw new Error(`update not stored: ${r.kind}`);
}

export async function readUpdates(store: AnyStore, docPath: string[]) {
  const out: { subspaceHex: string; update: Uint8Array; timestamp: bigint }[] = [];
  const area: Area<Uint8Array> = { includedSubspaceId: ANY_SUBSPACE, pathPrefix: snapshotPath(docPath), timeRange: { start: 0n, end: OPEN_END } };
  for await (const [entry, payload] of store.query({ area, maxCount: 0, maxSize: 0n }, "timestamp")) {
    const parts = partsOf(entry.path);
    // only this document's own entries: exactly the snapshot, or one level below "~u"
    if (parts.length !== docPath.length + 2 && parts.length !== docPath.length + 3) continue;
    if (!payload) continue;
    out.push({ subspaceHex: toHex(entry.subspaceId), update: await payload.bytes(), timestamp: entry.timestamp });
  }
  return out;
}

export async function loadDoc(store: AnyStore, docPath: string[]): Promise<Y.Doc> {
  const doc = new Y.Doc();
  for (const u of await readUpdates(store, docPath)) {
    // one corrupt update must not make the document unloadable for everyone
    try { Y.applyUpdate(doc, u.update); } catch {}
  }
  return doc;
}

const clientsOf = (update: Uint8Array): number[] => {
  try { return [...new Set(Y.decodeUpdate(update).structs.map((s) => s.id.client))]; } catch { return []; }
};

export async function compactOwn(store: AnyStore, kp: DeviceKeypair, docPath: string[]): Promise<void> {
  const me = toHex(kp.publicKey);
  const mine = (await readUpdates(store, docPath)).filter((u) => u.subspaceHex === me);
  if (mine.length < 2) return;
  const merged = Y.mergeUpdates(mine.map((u) => u.update));
  const newest = mine.reduce((t, u) => (u.timestamp > t ? u.timestamp : t), 0n);
  const r = await store.set({ path: snapshotPath(docPath), subspace: kp.publicKey, payload: merged, timestamp: newest + 1n }, kp);
  if (r.kind !== "success") throw new Error(`snapshot not stored: ${r.kind}`);
}

/** Yjs clientID → the device (subspace hex) that first used it, in timestamp order.
 *  A later update from another device reusing that id does not take it over. */
export async function authorsByClient(store: AnyStore, docPath: string[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const ups = (await readUpdates(store, docPath)).sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  for (const u of ups) for (const c of clientsOf(u.update)) if (!map.has(c)) map.set(c, u.subspaceHex);
  return map;
}

/** True when `update` uses a Yjs clientID that another device already owns in this
 *  document: peers refuse such an entry at ingest, so authorship cannot be forged. */
export async function clientClaimConflict(store: AnyStore, docPath: string[], subspaceHex: string, update: Uint8Array): Promise<boolean> {
  const owners = await authorsByClient(store, docPath);
  return clientsOf(update).some((c) => owners.has(c) && owners.get(c) !== subspaceHex);
}
