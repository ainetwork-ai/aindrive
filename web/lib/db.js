import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../drizzle/schema.js";

function dataDir() {
  const dir = process.env.AINDRIVE_DATA_DIR || join(homedir(), ".aindrive");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function open() {
  const path = join(dataDir(), "data.sqlite");
  const handle = new Database(path);
  handle.pragma("journal_mode = WAL");
  handle.pragma("foreign_keys = ON");
  handle.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS drives (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      agent_token_hash TEXT NOT NULL,
      drive_secret TEXT NOT NULL,
      last_seen_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS drive_members (
      id TEXT PRIMARY KEY,
      drive_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(drive_id, user_id, path),
      FOREIGN KEY(drive_id) REFERENCES drives(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY,
      drive_id TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      expires_at TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(drive_id) REFERENCES drives(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS folder_access (
      id TEXT PRIMARY KEY,
      drive_id TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '',
      wallet_address TEXT NOT NULL,
      added_by TEXT NOT NULL CHECK (added_by IN ('owner', 'payment')),
      payment_tx TEXT,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(drive_id, path, wallet_address),
      FOREIGN KEY(drive_id) REFERENCES drives(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS cli_link_requests (
      link_id TEXT PRIMARY KEY,
      device_secret_hash TEXT NOT NULL,
      user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_cli_link_expires ON cli_link_requests(expires_at);
    CREATE INDEX IF NOT EXISTS idx_drive_members_user ON drive_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_drive_members_drive ON drive_members(drive_id);
    CREATE INDEX IF NOT EXISTS idx_shares_drive ON shares(drive_id);
    CREATE INDEX IF NOT EXISTS idx_folder_access_lookup
      ON folder_access(drive_id, path, wallet_address);
    CREATE INDEX IF NOT EXISTS idx_folder_access_wallet ON folder_access(wallet_address);
  `);
  // Idempotent ALTERs (better-sqlite3 has no IF NOT EXISTS for ALTER)
  for (const stmt of [
    "ALTER TABLE shares ADD COLUMN price_usdc REAL",
    "ALTER TABLE shares ADD COLUMN payment_chain TEXT",
    "ALTER TABLE drives ADD COLUMN namespace_pubkey BLOB",
    "ALTER TABLE drives ADD COLUMN namespace_secret BLOB",
    "ALTER TABLE folder_access ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer'",
    "ALTER TABLE drives ADD COLUMN last_hostname TEXT",
  ]) {
    try { handle.exec(stmt); } catch (e) {
      if (!/duplicate column/i.test(e.message)) throw e;
    }
  }
  return handle;
}

export const db = globalThis.__aindrive_db ?? open();
if (!globalThis.__aindrive_db) globalThis.__aindrive_db = db;

export const drizzleDb = globalThis.__aindrive_drizzle_db ?? drizzle(db, { schema });
if (!globalThis.__aindrive_drizzle_db) globalThis.__aindrive_drizzle_db = drizzleDb;
