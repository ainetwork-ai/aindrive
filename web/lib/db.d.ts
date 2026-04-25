import type { Database } from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../drizzle/schema";

export const db: Database;
export const drizzleDb: BetterSQLite3Database<typeof schema>;
