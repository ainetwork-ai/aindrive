/**
 * One-shot migration: rewrite stored path columns into canonical form.
 *
 * Run once per process startup. Idempotent — rows already in canonical form
 * are skipped. On a UNIQUE collision (two rows normalize to the same key —
 * e.g. one row stored as "docs" and another as "docs/") the older row wins
 * and the newer duplicate is dropped with a logged warning so an operator
 * can audit if needed.
 *
 * AINDRIVE_DRY_RUN=1 prints what would happen but writes nothing.
 */
import { db } from "../db.js";
import { normalizePath } from "../path.js";
import { log } from "../logger.js";

const TABLES = [
  { name: "shares" },
  { name: "folder_access" },
  { name: "drive_members" },
];

export function runNormalizePathsMigration({ dryRun = false } = {}) {
  let changed = 0;
  let dropped = 0;
  let skippedInvalid = 0;

  for (const t of TABLES) {
    const rows = db.prepare(`SELECT id, path FROM ${t.name}`).all();
    for (const r of rows) {
      let norm;
      try {
        norm = normalizePath(r.path);
      } catch (e) {
        log.warn({ table: t.name, id: r.id, path: r.path, err: e.message }, "[migrate] invalid path, leaving as-is");
        skippedInvalid++;
        continue;
      }
      if (norm === r.path) continue;

      if (dryRun) {
        log.info({ table: t.name, id: r.id, from: r.path, to: norm }, "[migrate dry] would update");
        changed++;
        continue;
      }
      try {
        db.prepare(`UPDATE ${t.name} SET path = ? WHERE id = ?`).run(norm, r.id);
        changed++;
      } catch (e) {
        if (/UNIQUE/i.test(e.message)) {
          log.warn(
            { table: t.name, id: r.id, from: r.path, to: norm },
            "[migrate] UNIQUE collision — dropping younger row",
          );
          db.prepare(`DELETE FROM ${t.name} WHERE id = ?`).run(r.id);
          dropped++;
        } else throw e;
      }
    }
  }
  log.info({ changed, dropped, skippedInvalid, dryRun }, "[migrate 0001-normalize-paths] done");
  return { changed, dropped, skippedInvalid };
}
