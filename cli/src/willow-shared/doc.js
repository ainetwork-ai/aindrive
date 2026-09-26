// GENERATED from web/shared/willow/doc.ts by web/scripts/mirror-willow-to-cli.mjs — do not edit.
import * as Y from "yjs";
import { ANY_SUBSPACE, OPEN_END } from "@jsr/earthstar__willow-utils";
import { pathOf, partsOf, toHex, utf8 } from "./bytes.js";
import { certsFrom } from "./cert.js";
import { nowMicros } from "./schemes.js";
const snapshotPath = (docPath) => pathOf(["doc", ...docPath, "~u"]);
const updatePath = (docPath, seq) => pathOf(["doc", ...docPath, "~u", typeof seq === "number" ? String(seq).padStart(12, "0") : seq]);
async function appendUpdate(store, kp, docPath, update, seq, timestamp = nowMicros()) {
  const r = await store.set({ path: updatePath(docPath, seq), subspace: kp.publicKey, payload: update, timestamp }, kp);
  if (r.kind !== "success") throw new Error(`update not stored: ${r.kind}`);
}
async function readUpdates(store, docPath) {
  const out = [];
  const area = { includedSubspaceId: ANY_SUBSPACE, pathPrefix: snapshotPath(docPath), timeRange: { start: 0n, end: OPEN_END } };
  for await (const [entry, payload] of store.query({ area, maxCount: 0, maxSize: 0n }, "timestamp")) {
    const parts = partsOf(entry.path);
    if (parts.length !== docPath.length + 2 && parts.length !== docPath.length + 3) continue;
    if (!payload) continue;
    out.push({ subspaceHex: toHex(entry.subspaceId), update: await payload.bytes(), timestamp: entry.timestamp });
  }
  return out;
}
async function loadDoc(store, docPath, opts = {}) {
  const doc = new Y.Doc({ gc: opts.gc ?? true });
  for (const u of await readUpdates(store, docPath)) {
    try {
      Y.applyUpdate(doc, u.update);
    } catch {
    }
  }
  return doc;
}
const clientsOf = (update) => {
  try {
    return [...new Set(Y.decodeUpdate(update).structs.map((s) => s.id.client))];
  } catch {
    return [];
  }
};
async function compactOwn(store, kp, docPath) {
  const me = toHex(kp.publicKey);
  const mine = (await readUpdates(store, docPath)).filter((u) => u.subspaceHex === me);
  if (mine.length < 2) return;
  const merged = Y.mergeUpdates(mine.map((u) => u.update));
  const newest = mine.reduce((t, u) => u.timestamp > t ? u.timestamp : t, 0n);
  const r = await store.set({ path: snapshotPath(docPath), subspace: kp.publicKey, payload: merged, timestamp: newest + 1n }, kp);
  if (r.kind !== "success") throw new Error(`snapshot not stored: ${r.kind}`);
}
async function authorsByClient(store, docPath) {
  const map = /* @__PURE__ */ new Map();
  const ups = (await readUpdates(store, docPath)).sort((a, b) => a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0);
  for (const u of ups) for (const c of clientsOf(u.update)) if (!map.has(c)) map.set(c, u.subspaceHex);
  return map;
}
async function clientClaimConflict(store, docPath, subspaceHex, update) {
  const owners = await authorsByClient(store, docPath);
  return clientsOf(update).some((c) => owners.has(c) && owners.get(c) !== subspaceHex);
}
async function certsIn(store) {
  const raw = [];
  const area = { includedSubspaceId: ANY_SUBSPACE, pathPrefix: [utf8("_id"), utf8("cert")], timeRange: { start: 0n, end: OPEN_END } };
  for await (const [entry, payload] of store.query({ area, maxCount: 0, maxSize: 0n }, "timestamp")) {
    if (partsOf(entry.path).length !== 2 || !payload) continue;
    raw.push({ subspaceHex: toHex(entry.subspaceId), payload: await payload.bytes() });
  }
  return certsFrom(raw);
}
async function revocationsIn(store) {
  const out = [];
  const area = { includedSubspaceId: ANY_SUBSPACE, pathPrefix: [utf8("_id"), utf8("revoke")], timeRange: { start: 0n, end: OPEN_END } };
  for await (const [entry, payload] of store.query({ area, maxCount: 0, maxSize: 0n }, "timestamp")) {
    if (partsOf(entry.path).length !== 3 || !payload) continue;
    try {
      out.push(JSON.parse(new TextDecoder().decode(await payload.bytes())));
    } catch {
    }
  }
  return out;
}
export {
  appendUpdate,
  authorsByClient,
  certsIn,
  clientClaimConflict,
  compactOwn,
  loadDoc,
  readUpdates,
  revocationsIn,
  snapshotPath,
  updatePath
};
