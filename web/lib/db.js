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
  if (process.env.AINDRIVE_SQLITE_NO_WAL !== "1") {
    handle.pragma("synchronous = NORMAL");
    handle.pragma("busy_timeout = 5000");
  }
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
      payout_wallet TEXT,
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
      expires_at TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      currency TEXT,
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
    CREATE TABLE IF NOT EXISTS payment_receipts (
      id TEXT PRIMARY KEY,
      drive_id TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '',
      wallet TEXT NOT NULL,
      tx_hash TEXT NOT NULL UNIQUE,
      -- nullable: NULL means "amount unknown" (legacy backfilled receipts
      -- from before Phase 4 don't carry the original amount). A real 0
      -- amount is a different signal from "we don't know."
      amount_usdc REAL,
      network TEXT NOT NULL,
      share_id TEXT,
      settled_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(drive_id) REFERENCES drives(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_cli_link_expires ON cli_link_requests(expires_at);
    CREATE INDEX IF NOT EXISTS idx_drive_members_user ON drive_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_drive_members_drive ON drive_members(drive_id);
    CREATE INDEX IF NOT EXISTS idx_shares_drive ON shares(drive_id);
    CREATE INDEX IF NOT EXISTS idx_payment_receipts_wallet ON payment_receipts(wallet);
    CREATE INDEX IF NOT EXISTS idx_payment_receipts_drive_wallet ON payment_receipts(drive_id, wallet);
    CREATE TABLE IF NOT EXISTS account_wallets (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      wallet_address TEXT NOT NULL UNIQUE,
      linked_at TEXT NOT NULL DEFAULT (datetime('now')),
      verified_via TEXT NOT NULL DEFAULT 'siwe',
      FOREIGN KEY(account_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_account_wallets_account ON account_wallets(account_id);
    -- Invites for emails that don't have an account yet. On signup these convert
    -- to drive_members (upgrade-only) and are deleted; a registered invitee is
    -- granted immediately and never lands here. UNIQUE keeps one pending grant
    -- per (drive, email, path) — re-invite overwrites the role.
    CREATE TABLE IF NOT EXISTS drive_invites (
      id TEXT PRIMARY KEY,
      drive_id TEXT NOT NULL,
      email TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(drive_id, email, path),
      FOREIGN KEY(drive_id) REFERENCES drives(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_drive_invites_email ON drive_invites(email);
    CREATE INDEX IF NOT EXISTS idx_drive_invites_drive ON drive_invites(drive_id);
  `);
  // payment_chain → currency rename. Must run BEFORE the ADD loop: on a fresh
  // DB the CREATE above already made `currency`, so adding payment_chain first
  // would make this rename throw "duplicate column" on every first boot.
  // Ignore "no such column" (fresh DB / already renamed) and "duplicate
  // column" (half-state where both somehow exist).
  try {
    handle.exec("ALTER TABLE shares RENAME COLUMN payment_chain TO currency");
  } catch (e) {
    if (!/no such column|duplicate column/i.test(e.message)) throw e;
  }
  // Idempotent ALTERs (better-sqlite3 has no IF NOT EXISTS for ALTER)
  for (const stmt of [
    "ALTER TABLE shares ADD COLUMN price_usdc REAL",
    // covers pre-payment_chain DBs that the rename above skipped
    "ALTER TABLE shares ADD COLUMN currency TEXT",
    "ALTER TABLE shares ADD COLUMN listed INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE drives ADD COLUMN allowed_tokens TEXT",
    "ALTER TABLE drives ADD COLUMN namespace_pubkey BLOB",
    "ALTER TABLE drives ADD COLUMN namespace_secret BLOB",
    "ALTER TABLE drives ADD COLUMN last_hostname TEXT",
    "ALTER TABLE drives ADD COLUMN payout_wallet TEXT",
    "ALTER TABLE payment_receipts ADD COLUMN account_id TEXT",
  ]) {
    try { handle.exec(stmt); } catch (e) {
      if (!/duplicate column/i.test(e.message)) throw e;
    }
  }
  // Index on payment_receipts(account_id) added after the ALTER that creates
  // the column (CREATE INDEX IF NOT EXISTS is safe to run every startup).
  handle.exec(`
    CREATE INDEX IF NOT EXISTS idx_payment_receipts_account ON payment_receipts(account_id);
  `);
  return handle;
}

export const db = globalThis.__aindrive_db ?? open();
if (!globalThis.__aindrive_db) globalThis.__aindrive_db = db;

export const drizzleDb = globalThis.__aindrive_drizzle_db ?? drizzle(db, { schema });
if (!globalThis.__aindrive_drizzle_db) globalThis.__aindrive_drizzle_db = drizzleDb;

if (!globalThis.__aindrive_maintenance_started) {
  globalThis.__aindrive_maintenance_started = true;
  import("./sqlite-maintenance.js").then(({ startSqliteMaintenance }) => startSqliteMaintenance()).catch(() => {});
}
