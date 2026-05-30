/**
 * Make payment_receipts.amount_usdc nullable.
 *
 * Phase 4 originally created the column NOT NULL with a 0 sentinel for
 * legacy backfilled rows. Type-design-analyzer review flagged that as a
 * leaky invariant — a true zero-payment and "unknown legacy amount" become
 * indistinguishable. We now treat NULL as the "unknown" marker.
 *
 * SQLite cannot ALTER COLUMN to drop NOT NULL. The supported recipe is:
 *   - CREATE TABLE _new with the new schema
 *   - INSERT INTO _new SELECT * FROM payment_receipts (with column list)
 *   - DROP TABLE payment_receipts
 *   - ALTER TABLE _new RENAME TO payment_receipts
 *   - Recreate the indexes
 *
 * All wrapped in a transaction so a partial failure leaves the original
 * untouched.
 *
 * Idempotent: PRAGMA table_info(payment_receipts) is inspected first; if
 * the amount_usdc column is already nullable (notnull = 0) the migration
 * is a no-op. Safe to run on every boot.
 *
 * AINDRIVE_DRY_RUN=1 prints what would happen without writing.
 */
import { db } from "../db.js";
import { log } from "../logger.js";

export function runReceiptsAmountNullableMigration({ dryRun = false } = {}) {
  const cols = db.prepare("PRAGMA table_info(payment_receipts)").all();
  const amountCol = cols.find((c) => c.name === "amount_usdc");
  if (!amountCol) {
    log.info("[migrate 0003] payment_receipts.amount_usdc not present — skip");
    return { recreated: false };
  }
  if (amountCol.notnull === 0) {
    // Already nullable. No work.
    return { recreated: false };
  }

  if (dryRun) {
    log.info("[migrate 0003 dry] would recreate payment_receipts to drop NOT NULL on amount_usdc");
    return { recreated: false, dryRun: true };
  }

  const recreate = db.transaction(() => {
    db.exec(`
      CREATE TABLE payment_receipts_new (
        id TEXT PRIMARY KEY,
        drive_id TEXT NOT NULL,
        path TEXT NOT NULL DEFAULT '',
        wallet TEXT NOT NULL,
        tx_hash TEXT NOT NULL UNIQUE,
        amount_usdc REAL,
        network TEXT NOT NULL,
        share_id TEXT,
        settled_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY(drive_id) REFERENCES drives(id) ON DELETE CASCADE
      );
      INSERT INTO payment_receipts_new (id, drive_id, path, wallet, tx_hash, amount_usdc, network, share_id, settled_at)
        SELECT id, drive_id, path, wallet, tx_hash,
               -- Map legacy 0 sentinel to NULL on the way through.
               CASE WHEN amount_usdc = 0 THEN NULL ELSE amount_usdc END,
               network, share_id, settled_at
        FROM payment_receipts;
      DROP TABLE payment_receipts;
      ALTER TABLE payment_receipts_new RENAME TO payment_receipts;
      CREATE INDEX IF NOT EXISTS idx_payment_receipts_wallet ON payment_receipts(wallet);
      CREATE INDEX IF NOT EXISTS idx_payment_receipts_drive_wallet ON payment_receipts(drive_id, wallet);
    `);
  });

  try {
    recreate();
    log.info("[migrate 0003] payment_receipts.amount_usdc now nullable; legacy 0 sentinels mapped to NULL");
    return { recreated: true };
  } catch (e) {
    log.error({ err: e.message }, "[migrate 0003] failed");
    throw e;
  }
}
