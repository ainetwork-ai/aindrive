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

/** `readOnly`: never append (a viewer): local changes, such as a seed from disk, stay local and unsigned. */
export async function bindDoc(o: { store: AnyStore; key: DeviceKeypair; docPath: string[]; doc: Y.Doc; nextSeq(): Promise<number | string>; readOnly?: boolean }): Promise<() => void> {
  const origin = Symbol("willow");
  for (const u of await readUpdates(o.store, o.docPath)) Y.applyUpdate(o.doc, u.update, origin);

  // Appends run one at a time; whatever is typed while one is in flight is merged
  // into the next entry, so a burst of keystrokes becomes one signed entry and the
  // queue drains fast (a tab closed right after typing loses as little as possible).
  let pending: Uint8Array[] = [];
  let running = false;
  const drain = async () => {
    if (running) return;
    running = true;
    try {
      while (pending.length) {
        const batch = pending;
        pending = [];
        const update = batch.length === 1 ? batch[0] : Y.mergeUpdates(batch);
        try { await appendUpdate(o.store, o.key, o.docPath, update, await o.nextSeq()); }
        catch (e) { console.warn("willow append failed:", e); }
      }
    } finally { running = false; }
  };
  const onLocal = (update: Uint8Array, from: unknown) => {
    if (from === origin || o.readOnly) return;
    pending.push(update);
    void drain();
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
