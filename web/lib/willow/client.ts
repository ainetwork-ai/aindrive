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
import { bindDoc } from "@/shared/willow/y-binding";
import { authorsByClient, certsIn, type AnyStore } from "@/shared/willow/doc";
import { labelFor } from "@/components/editors/authorship";
import type { Frame } from "@/shared/willow/wire";


async function idb<T>(dbName: string, fn: (os: IDBObjectStore) => IDBRequest<T>, mode: IDBTransactionMode = "readonly"): Promise<T> {
  const db = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open(dbName, 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return new Promise((res, rej) => { const req = fn(db.transaction("kv", mode).objectStore("kv")); req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
}

/** The signed-in user's id. Online, the server says (and signed-out clears the
 *  memory); offline, the last user seen here, so their store still opens. */
async function whoAmI(): Promise<string | null> {
  const LAST = "aindrive-willow-last-user";
  let r: Response;
  try { r = await fetch("/api/whoami"); } catch {
    try { return localStorage.getItem(LAST); } catch { return null; }
  }
  const id = ((await r.json().catch(() => ({}))) as { id?: string | null }).id ?? null;
  try { if (id) localStorage.setItem(LAST, id); else localStorage.removeItem(LAST); } catch {}
  return id;
}

/** The device key of this browser FOR THIS USER (review C4): a second person
 *  signing in on the same browser gets their own key, stores and certificate. */
export async function deviceKey(userId: string): Promise<DeviceKeypair> {
  const dbName = `aindrive-device-${userId}`;
  const hit = await idb<{ s: string; p: string } | undefined>(dbName, (os) => os.get("key"));
  if (hit) return { secretKey: fromHex(hit.s), publicKey: fromHex(hit.p) };
  const kp = await generateDeviceKey();
  await idb(dbName, (os) => os.put({ s: toHex(kp.secretKey), p: toHex(kp.publicKey) }, "key"), "readwrite");
  return kp;
}

const clients = new Map<string, ReturnType<typeof connect>>();

export function willowClient(driveId: string) {
  let c = clients.get(driveId);
  if (!c) {
    c = connect(driveId);
    clients.set(driveId, c);
    c.catch(() => clients.delete(driveId)); // a failed start is retried next time, not cached
  }
  return c;
}

async function connect(driveId: string) {
  const me = { id: await whoAmI() };
  if (!me.id) throw new Error("signed out: no Willow store");
  const key = await deviceKey(me.id);
  const kv = new KvDriverIndexedDB(`aindrive-willow-${me.id}-${driveId}`);
  const payloadDriver = new PayloadDriverIndexedDb<Uint8Array>(`aindrive-willow-payloads-${me.id}-${driveId}`, aindriveSchemes.payload as never);
  const store = new Store({
    namespace: namespaceOf(driveId), schemes: aindriveSchemes, payloadDriver,
    entryDriver: new EntryDriverKvStore({ kvDriver: kv, namespaceScheme: aindriveSchemes.namespace, subspaceScheme: aindriveSchemes.subspace, payloadScheme: aindriveSchemes.payload, pathScheme: aindriveSchemes.path, fingerprintScheme: aindriveSchemes.fingerprint, getPayloadLength: (d) => payloadDriver.length(d) }),
  }) as AnyStore;
  const status = new EventTarget();

  // my certificate, once per device; stored as an entry so it syncs with my edits
  const certPath = pathOf(["_id", "cert"]);
  let hasCert = false;
  for await (const [entry, payload] of store.query({ area: { includedSubspaceId: key.publicKey, pathPrefix: certPath, timeRange: { start: 0n, end: OPEN_END } }, maxCount: 1, maxSize: 0n }, "timestamp")) {
    if (!equalBytes(entry.subspaceId, key.publicKey) || !payload) continue;
    try { hasCert = JSON.parse(new TextDecoder().decode(await payload.bytes())).userId === me.id; } catch {}
  }
  if (!hasCert) {
    const r = await fetch("/api/willow/cert", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceKey: toHex(key.publicKey), label: navigator.userAgent.slice(0, 60) }) }).catch(() => null);
    if (r?.ok) { const { cert } = await r.json(); await store.set({ path: certPath, subspace: key.publicKey, payload: utf8(JSON.stringify(cert)) }, key); }
  }

  // Sequence numbers name update paths, so two appends must never share one (the
  // newer entry would prune the older): µs time, a random 32-bit tab id, a counter.
  const tabId = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
  let counter = 0;
  const nextSeq = async () => `${Date.now() * 1000}-${tabId}-${++counter}`;

  // the first sync with the server: true once it really completed, false when we
  // gave up (offline, no access, 8 s). Only a true one may seed a document from disk.
  let firstSync!: (complete: boolean) => void;
  const initialSync = new Promise<boolean>((r) => { firstSync = r; });
  setTimeout(() => firstSync(false), 8000);

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
        onSynced: () => firstSync(true),
      }).start();
    };
    ws.onclose = (ev) => {
      closes.forEach((c) => c());
      firstSync(false);
      status.dispatchEvent(new Event("offline"));
      if (ev.code === 4401 || ev.code === 4402) return; // no access: do not hammer
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 15_000);
    };
  };
  open();

  // "who wrote this": Yjs client → signing device → certificate → person
  let people: Promise<Map<string, string>> | null = null;
  let attestation: Promise<string[]> | null = null;
  const authorLabel = async (docPath: string[], client: number): Promise<string | null> => {
    const device = (await authorsByClient(store, docPath)).get(client);
    if (!device) return null;
    people ??= fetch(`/api/willow/people?drive=${encodeURIComponent(driveId)}`).then((r) => r.json()).then((j) => new Map(Object.entries((j.people ?? {}) as Record<string, string>))).catch(() => new Map());
    attestation ??= fetch("/api/willow/cert").then((r) => r.json()).then((j) => [j.attestationKey as string]).catch(() => []);
    return labelFor(device, await certsIn(store), { attestationKeys: await attestation, verifyWallet: async () => null }, await people);
  };

  return {
    store, key, status, initialSync, authorLabel,
    // the doc keeps its own random clientID: Awareness captured it at construction
    openDoc: (docPath: string[], doc: Y.Doc, readOnly = false) => bindDoc({ store, key, docPath, doc, nextSeq, readOnly }),
  };
}
