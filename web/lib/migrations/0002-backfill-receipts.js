/**
 * Backfill payment_receipts from legacy folder_access.payment_tx values.
 *
 * Before Phase 4, every settled x402 payment landed in folder_access.payment_tx
 * directly. That column could only hold one tx_hash per (drive, path, wallet),
 * so re-payments silently overwrote earlier receipts. The new payment_receipts
 * table is append-only and tx_hash UNIQUE.
 *
 * This migration copies every legacy non-null payment_tx into payment_receipts
 * as a one-time seed. Idempotent: the INSERT ignores tx_hash UNIQUE collisions,
 * so re-running on subsequent boots is a no-op.
 *
 * Limitations of the seeded rows:
 *   - amount_usdc is recorded as NULL — the historical share's price may
 *     have changed since, and "unknown amount" is a different signal from
 *     "zero amount." Analytics queries should filter `WHERE amount_usdc IS
 *     NOT NULL` to exclude these legacy rows.
 *   - network is hard-coded to "base-sepolia" — the only network shipped
 *     pre-Phase 4.
 *   - share_id is unknown without joining on (drive_id, path); we leave it
 *     null and accept losing that linkage for pre-existing receipts.
 *
 * AINDRIVE_DRY_RUN=1 prints would-be inserts without writing.
 */
import { nanoid } from "nanoid";
import { db } from "../db.js";
import { log } from "../logger.js";

export function runBackfillReceiptsMigration({ dryRun = false } = {}) {
  const rows = db
    .prepare(
      "SELECT id, drive_id, path, wallet_address, payment_tx, added_at FROM folder_access WHERE added_by = 'payment' AND payment_tx IS NOT NULL",
    )
    .all();

  let inserted = 0;
  let alreadyPresent = 0;
  for (const r of rows) {
    if (dryRun) {
      log.info(
        { folder_access_id: r.id, drive_id: r.drive_id, wallet: r.wallet_address, tx_hash: r.payment_tx },
        "[migrate dry] would seed receipt",
      );
      inserted++;
      continue;
    }
    try {
      db.prepare(
        "INSERT INTO payment_receipts (id, drive_id, path, wallet, tx_hash, amount_usdc, network, share_id, settled_at) VALUES (?, ?, ?, ?, ?, NULL, 'base-sepolia', NULL, ?)",
      ).run(nanoid(12), r.drive_id, r.path, r.wallet_address, r.payment_tx, r.added_at);
      inserted++;
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) {
        alreadyPresent++;
        continue;
      }
      throw e;
    }
  }
  log.info({ inserted, alreadyPresent, dryRun }, "[migrate 0002-backfill-receipts] done");
  return { inserted, alreadyPresent };
}
