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
