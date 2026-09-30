#!/usr/bin/env node
// Operator: run once after putting the SQLite database back from a backup (and
// after rolling forward from a release that did not write the change feed),
// with the server STOPPED, before starting it again. Runs against the server's
// DB (AINDRIVE_DATA_DIR) with the server's env — in production:
//   docker compose run --rm web node scripts/after-restore.mjs
// What it does and why: lib/share-events-restore.js. Prints what it changed;
// `--dry-run` only prints.

const args = process.argv.slice(2);
if (args.includes("--help") || args.some((a) => a !== "--dry-run")) {
  console.log("usage: node scripts/after-restore.mjs [--dry-run]");
  process.exit(args.includes("--help") ? 0 : 1);
}
await import("../lib/load-env.js");
const { db } = await import("../lib/db.js");
const { resetShareEventCursors } = await import("../lib/share-events-restore.js");
const r = resetShareEventCursors(db, { dryRun: args.includes("--dry-run") });
console.log(
  `${r.dryRun ? "[dry run] would reset" : "reset"} the change feed: next seq after ${r.base} (was ${r.previousMaxSeq}), ` +
    `floors raised for ${r.recipients} account(s) (every older cursor answers gap: true), ${r.resources} resource version(s) +1000000`,
);
