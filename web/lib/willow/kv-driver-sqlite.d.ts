import type { KvDriver } from "@earthstar/willow";
import type Database from "better-sqlite3";
export declare class KvDriverSqlite implements KvDriver {
  constructor(db: Database.Database);
  get: KvDriver["get"]; set: KvDriver["set"]; delete: KvDriver["delete"]; list: KvDriver["list"]; clear: KvDriver["clear"]; batch: KvDriver["batch"];
}
