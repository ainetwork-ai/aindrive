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
    const { entry } = (ev as CustomEvent<{ entry: Parameters<AnyStore["getPayload"]>[0] }>).detail;
    if (!isThisDoc(entry.path)) return;
    const payload = await o.store.getPayload(entry);
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
