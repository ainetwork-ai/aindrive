// The folder's agent as a Willow peer (spec §6, plan 3): a device of the drive's
// owner. Its key lives in .aindrive/device.key (0600), its store in
// .aindrive/willow-store.sqlite + willow-payloads/, its certificate comes from the
// server with the agent token, and it syncs with the server peer over
// /api/willow/sync (same SyncSession as the browser), reconnecting with backoff.
import WebSocket from "ws";
import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { Store, EntryDriverKvStore } from "@earthstar/willow";
import { OPEN_END } from "@jsr/earthstar__willow-utils";
import { KvDriverSqlite } from "./willow/kv-driver-sqlite.js";
import { PayloadDriverFs } from "./willow-payload-fs.js";
import { aindriveSchemes, namespaceOf } from "./willow-shared/schemes.js";
import { generateDeviceKey } from "./willow-shared/keys.js";
import { equalBytes, fromHex, pathOf, toHex, utf8 } from "./willow-shared/bytes.js";
import { SyncSession, fullRange } from "./willow-shared/session.js";

const BACKOFF_MS = [500, 1000, 2000, 5000, 10000, 30000];

async function deviceKey(dir) {
  const file = join(dir, "device.key");
  if (existsSync(file)) {
    const { s, p } = JSON.parse(readFileSync(file, "utf8"));
    return { secretKey: fromHex(s), publicKey: fromHex(p) };
  }
  const kp = await generateDeviceKey();
  writeFileSync(file, JSON.stringify({ s: toHex(kp.secretKey), p: toHex(kp.publicKey) }), { mode: 0o600 });
  chmodSync(file, 0o600);
  return kp;
}

function openStore(dir, driveId) {
  const db = new Database(join(dir, "willow-store.sqlite"));
  db.pragma("journal_mode = WAL");
  const payloadDriver = new PayloadDriverFs(join(dir, "willow-payloads"));
  const s = aindriveSchemes;
  const store = new Store({
    namespace: namespaceOf(driveId), schemes: s, payloadDriver,
    entryDriver: new EntryDriverKvStore({ kvDriver: new KvDriverSqlite(db), namespaceScheme: s.namespace, subspaceScheme: s.subspace, payloadScheme: s.payload, pathScheme: s.path, fingerprintScheme: s.fingerprint, getPayloadLength: (d) => payloadDriver.length(d) }),
  });
  return { store, db };
}

async function hasOwnCert(store, key) {
  const area = { includedSubspaceId: key.publicKey, pathPrefix: pathOf(["_id", "cert"]), timeRange: { start: 0n, end: OPEN_END } };
  for await (const [entry] of store.query({ area, maxCount: 1, maxSize: 0n }, "timestamp")) if (equalBytes(entry.subspaceId, key.publicKey)) return true;
  return false;
}

const wsUrlFor = (server, driveId) => `${server.replace(/^http/, "ws").replace(/\/+$/, "")}/api/willow/sync?drive=${encodeURIComponent(driveId)}`;

/**
 * @param {{ root: string, drive: { driveId: string, agentToken: string }, server: string,
 *           connect?: (url: string, headers: Record<string,string>) => any, fetchImpl?: typeof fetch,
 *           log?: { info: Function, warn: Function } }} o
 */
export async function startWillowPeer(o) {
  const dir = join(o.root, ".aindrive");
  mkdirSync(dir, { recursive: true });
  const key = await deviceKey(dir);
  const { store, db } = openStore(dir, o.drive.driveId);
  const log = o.log ?? { info() {}, warn() {} };
  const fetchImpl = o.fetchImpl ?? fetch;
  const headers = { authorization: `Bearer ${o.drive.agentToken}` };

  const ensureCert = async () => {
    if (await hasOwnCert(store, key)) return;
    const r = await fetchImpl(`${o.server.replace(/\/+$/, "")}/api/willow/cert`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ deviceKey: toHex(key.publicKey), label: `agent on ${hostname()}`, drive: o.drive.driveId }),
    });
    if (!r.ok) throw new Error(`certificate: ${r.status}`);
    const { cert } = await r.json();
    const res = await store.set({ path: pathOf(["_id", "cert"]), subspace: key.publicKey, payload: utf8(JSON.stringify(cert)) }, key);
    if (res.kind !== "success") throw new Error("certificate not stored");
  };

  let stopped = false, attempt = 0, current = null, timer = null, session = null;
  const connect = o.connect ?? ((url, h) => new WebSocket(url, { headers: h, maxPayload: 8 * 1024 * 1024 }));
  const open = () => {
    if (stopped) return;
    const ws = connect(wsUrlFor(o.server, o.drive.driveId), headers);
    current = ws;
    const frames = [], closes = [];
    ws.on("message", (d) => { let f; try { f = JSON.parse(String(d)); } catch { return; } for (const cb of frames) cb(f); });
    ws.on("open", () => {
      attempt = 0;
      log.info({ driveId: o.drive.driveId }, "willow sync connected");
      session = new SyncSession({
        store, ranges: [fullRange()],
        channel: { send: (f) => { if (ws.readyState === 1) ws.send(JSON.stringify(f)); }, onFrame: (cb) => frames.push(cb), onClose: (cb) => closes.push(cb) },
        onRefused: (f) => log.warn({ path: f.path.join("/"), reason: f.reason }, "willow: server refused an entry"),
      });
      void session.start();
    });
    ws.on("close", (code) => {
      closes.forEach((c) => c());
      if (stopped) return;
      const wait = BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)];
      if (code === 4401) log.warn({}, "willow sync: not authorised");
      timer = setTimeout(open, wait);
    });
    ws.on("error", () => {});
  };

  try { await ensureCert(); } catch (e) { log.warn({ err: e.message }, "willow certificate unavailable; retrying on next start"); }
  if (o.beforeSync) { try { await o.beforeSync(store, key); } catch (e) { log.warn({ err: e.message }, "willow beforeSync failed"); } }
  open();

  return {
    store, key,
    /** Stops syncing, lets the frame in hand finish, then closes the store. */
    async stop() {
      stopped = true;
      clearTimeout(timer);
      session?.close();
      try { current?.close(); } catch {}
      await session?.drained();
      try { db.close(); } catch {}
    },
  };
}
