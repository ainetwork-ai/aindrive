// Migration test for payment_receipts.currency: a DB created BEFORE the column
// existed must gain it (ALTER) and get backfilled — inheriting the share's
// currency, falling back to 'USDC' when the share is gone or its currency is
// NULL. We seed a pre-currency data.sqlite, then importing db.js runs open()'s
// real migration path against it.
import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "aindrive-receipt-migration-"));
process.env.AINDRIVE_DATA_DIR = dataDir;

// Seed the OLD schema (payment_receipts WITHOUT currency) and rows BEFORE db.js
// opens the file. open() finds the table already present, so CREATE IF NOT
// EXISTS is skipped and the idempotent ALTER + backfill do the migration.
function seedLegacyDb() {
  const handle = new Database(join(dataDir, "data.sqlite"));
  handle.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password_hash TEXT NOT NULL);
    CREATE TABLE drives (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, agent_token_hash TEXT NOT NULL, drive_secret TEXT NOT NULL);
    CREATE TABLE shares (id TEXT PRIMARY KEY, drive_id TEXT NOT NULL, path TEXT NOT NULL DEFAULT '', role TEXT NOT NULL, token TEXT UNIQUE NOT NULL, currency TEXT);
    CREATE TABLE payment_receipts (
      id TEXT PRIMARY KEY, drive_id TEXT NOT NULL, path TEXT NOT NULL DEFAULT '',
      wallet TEXT NOT NULL, tx_hash TEXT NOT NULL UNIQUE, amount_usdc REAL,
      network TEXT NOT NULL, share_id TEXT, settled_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  handle.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("u1", "u@x.com", "U", "x");
  handle.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)").run("dr1", "u1", "D", "h", "s");
  handle.prepare("INSERT INTO shares (id, drive_id, path, role, token, currency) VALUES (?,?,?,?,?,?)").run("s_fanco", "dr1", "media", "viewer", "shtok_fanco", "FANCO");
  handle.prepare("INSERT INTO shares (id, drive_id, path, role, token, currency) VALUES (?,?,?,?,?,?)").run("s_null", "dr1", "docs", "viewer", "shtok_null", null);

  const insReceipt = handle.prepare(
    "INSERT INTO payment_receipts (id, drive_id, path, wallet, tx_hash, amount_usdc, network, share_id) VALUES (?,?,?,?,?,?,?,?)"
  );
  // (a) share alive with a currency → inherits it.
  insReceipt.run("rc_fanco", "dr1", "media", "0xaaa", "0xtx_fanco", 300, "base", "s_fanco");
  // (b) share alive but currency NULL (pre-policy sale) → USDC fallback.
  insReceipt.run("rc_nullshare", "dr1", "docs", "0xbbb", "0xtx_nullshare", 12, "base", "s_null");
  // (c) share deleted (share_id points at nothing) → USDC fallback.
  insReceipt.run("rc_deleted", "dr1", "docs", "0xccc", "0xtx_deleted", 5, "base", "gone_share");
  // (d) share_id NULL → USDC fallback.
  insReceipt.run("rc_nullid", "dr1", "", "0xddd", "0xtx_nullid", 7, "base", null);
  handle.close();
}

seedLegacyDb();
const { db } = await import("../db.js");

function currencyOf(id: string): string | null {
  return (db.prepare("SELECT currency FROM payment_receipts WHERE id = ?").get(id) as { currency: string | null }).currency;
}

describe("payment_receipts.currency migration + backfill", () => {
  it("adds the currency column to a pre-currency DB", () => {
    const cols = (db.prepare("PRAGMA table_info(payment_receipts)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("currency");
  });

  it("backfills from the originating share's currency when it is alive", () => {
    expect(currencyOf("rc_fanco")).toBe("FANCO");
  });

  it("falls back to USDC when the share's currency is NULL, the share is gone, or share_id is NULL", () => {
    expect(currencyOf("rc_nullshare")).toBe("USDC");
    expect(currencyOf("rc_deleted")).toBe("USDC");
    expect(currencyOf("rc_nullid")).toBe("USDC");
  });

  it("leaves no receipt with NULL currency after migration", () => {
    const nulls = db.prepare("SELECT COUNT(*) AS n FROM payment_receipts WHERE currency IS NULL").get() as { n: number };
    expect(nulls.n).toBe(0);
  });
});
