// web/lib/willow/client.ts
// The browser's Willow peer (spec §6): a device key and store in IndexedDB, a
// certificate from /api/willow/cert, and a sync session to /api/willow/sync that
// reconnects with backoff. Offline, edits go to the store and sync on reconnect.
"use client";
import { Store, EntryDriverKvStore } from "@earthstar/willow";
import { KvDriverIndexedDB, PayloadDriverIndexedDb } from "@earthstar/willow/browser";
import { OPEN_END } from "@jsr/earthstar__willow-utils";
import * as Y from "yjs";
import { aindriveSchemes, namespaceOf } from "@/shared/willow/schemes";
import { generateDeviceKey, type DeviceKeypair } from "@/shared/willow/keys";
import { equalBytes, fromHex, pathOf, toHex, utf8 } from "@/shared/willow/bytes";
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
  const payloadDriver = new PayloadDriverIndexedDb<Uint8Array>(`aindrive-willow-payloads-${driveId}`, aindriveSchemes.payload as never);
  const store = new Store({
    namespace: namespaceOf(driveId), schemes: aindriveSchemes, payloadDriver,
    entryDriver: new EntryDriverKvStore({ kvDriver: kv, namespaceScheme: aindriveSchemes.namespace, subspaceScheme: aindriveSchemes.subspace, payloadScheme: aindriveSchemes.payload, pathScheme: aindriveSchemes.path, fingerprintScheme: aindriveSchemes.fingerprint, getPayloadLength: (d) => payloadDriver.length(d) }),
  }) as AnyStore;
  const status = new EventTarget();

  // my certificate, once per device; stored as an entry so it syncs with my edits
  const certPath = pathOf(["_id", "cert"]);
  let hasCert = false;
  for await (const [entry] of store.query({ area: { includedSubspaceId: key.publicKey, pathPrefix: certPath, timeRange: { start: 0n, end: OPEN_END } }, maxCount: 1, maxSize: 0n }, "timestamp")) {
    if (equalBytes(entry.subspaceId, key.publicKey)) hasCert = true;
  }
  if (!hasCert) {
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
