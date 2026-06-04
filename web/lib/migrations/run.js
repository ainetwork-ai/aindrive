/**
 * Run every one-shot migration in order, once per server startup.
 * Each migration MUST be idempotent so re-running on the next boot is safe.
 */
import { runNormalizePathsMigration } from "./0001-normalize-paths.js";
import { runReceiptsAmountNullableMigration } from "./0003-receipts-amount-nullable.js";

export function runAllMigrations({ dryRun = process.env.AINDRIVE_DRY_RUN === "1" } = {}) {
  runNormalizePathsMigration({ dryRun });
  runReceiptsAmountNullableMigration({ dryRun });
}
