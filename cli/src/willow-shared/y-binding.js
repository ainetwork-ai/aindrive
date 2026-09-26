// GENERATED from web/shared/willow/y-binding.ts by web/scripts/mirror-willow-to-cli.mjs — do not edit.
import * as Y from "yjs";
import { partsOf } from "./bytes.js";
import { appendUpdate, readUpdates } from "./doc.js";
function clientIdFor(key, tab) {
  const k = key.publicKey;
  return ((k[0] << 24 | k[1] << 16 | k[2] << 8 | k[3]) ^ Math.imul(tab, 2654435761)) >>> 0;
}
async function bindDoc(o) {
  const origin = /* @__PURE__ */ Symbol("willow");
  for (const u of await readUpdates(o.store, o.docPath)) Y.applyUpdate(o.doc, u.update, origin);
  let pending = [];
  let running = false;
  const drain = async () => {
    if (running) return;
    running = true;
    try {
      while (pending.length) {
        const batch = pending;
        pending = [];
        const update = batch.length === 1 ? batch[0] : Y.mergeUpdates(batch);
        try {
          await appendUpdate(o.store, o.key, o.docPath, update, await o.nextSeq());
        } catch (e) {
          console.warn("willow append failed:", e);
        }
      }
    } finally {
      running = false;
    }
  };
  const onLocal = (update, from) => {
    if (from === origin || o.readOnly) return;
    pending.push(update);
    void drain();
  };
  o.doc.on("update", onLocal);
  const isThisDoc = (path) => {
    const p = partsOf(path);
    return p[0] === "doc" && p.length >= o.docPath.length + 2 && o.docPath.every((c, i) => p[i + 1] === c) && p[o.docPath.length + 1] === "~u" && p.length <= o.docPath.length + 3;
  };
  const onEntry = async (ev) => {
    const { entry } = ev.detail;
    if (!isThisDoc(entry.path)) return;
    const payload = await o.store.getPayload(entry);
    if (payload) Y.applyUpdate(o.doc, await payload.bytes(), origin);
  };
  o.store.addEventListener("payloadingest", onEntry);
  o.store.addEventListener("entrypayloadset", onEntry);
  return () => {
    o.doc.off("update", onLocal);
    o.store.removeEventListener("payloadingest", onEntry);
    o.store.removeEventListener("entrypayloadset", onEntry);
  };
}
export {
  bindDoc,
  clientIdFor
};
