/**
 * Run every one-shot migration in order, once per server startup.
 * Each migration MUST be idempotent so re-running on the next boot is safe.
 */
import { runNormalizePathsMigration } from "./0001-normalize-paths.js";
import { runBackfillReceiptsMigration } from "./0002-backfill-receipts.js";
import { runReceiptsAmountNullableMigration } from "./0003-receipts-amount-nullable.js";

export function runAllMigrations({ dryRun = process.env.AINDRIVE_DRY_RUN === "1" } = {}) {
  runNormalizePathsMigration({ dryRun });
  // 0003 must run BEFORE 0002 — backfill inserts NULL amount_usdc, which
  // requires the column to already be nullable.
  runReceiptsAmountNullableMigration({ dryRun });
  runBackfillReceiptsMigration({ dryRun });
}
