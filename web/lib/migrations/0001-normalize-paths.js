/**
 * One-shot migration: rewrite stored path columns into canonical form.
 *
 * Run once per process startup. Idempotent — rows already in canonical form
 * are skipped. On a UNIQUE collision (two rows normalize to the same key —
 * e.g. "docs" and "docs/", or the NFC and NFD spellings of one folder) the
 * row already in canonical form is kept and the other is dropped with a logged
 * warning so an operator can audit. Grants and pending invites first raise the
 * kept row to the higher of the two roles (upgrade-only, docs/PERMISSIONS.md),
 * so a collision never lowers anyone's access.
 *
 * AINDRIVE_DRY_RUN=1 prints what would happen but writes nothing.
 */
import { db } from "../db.js";
import { normalizePath } from "../path.js";
import { mergeRoleUpgradeOnly } from "../access-core.js";
import { log } from "../logger.js";

// Every table whose `path` names a drive location. `unique`: the columns that,
// with path, form the table's UNIQUE key. `role`: merge roles on collision.
// (upload_sessions.path is an in-flight upload's destination name — the agent
// resolves either spelling, and the row is gone once the upload finishes.)
const TABLES = [
  { name: "shares" },
  { name: "payment_receipts" },
  { name: "drive_members", unique: ["drive_id", "user_id"], role: true },
  { name: "drive_invites", unique: ["drive_id", "email"], role: true },
  { name: "drive_payout_wallets", unique: ["drive_id"] },
];

export function runNormalizePathsMigration({ dryRun = false } = {}) {
  let changed = 0;
  let dropped = 0;
  let skippedInvalid = 0;

  for (const t of TABLES) {
    const cols = ["id", "path", ...(t.unique ?? []), ...(t.role ? ["role"] : [])];
    const rows = db.prepare(`SELECT ${cols.join(", ")} FROM ${t.name}`).all();
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
        if (/UNIQUE/i.test(e.message) && t.unique) {
          const keep = db
            .prepare(`SELECT id${t.role ? ", role" : ""} FROM ${t.name} WHERE ${t.unique.map((c) => `${c} = ?`).join(" AND ")} AND path = ?`)
            .get(...t.unique.map((c) => r[c]), norm);
          if (t.role && keep) {
            db.prepare(`UPDATE ${t.name} SET role = ? WHERE id = ?`).run(mergeRoleUpgradeOnly(keep.role, r.role), keep.id);
          }
          log.warn(
            { table: t.name, id: r.id, keptId: keep?.id, from: r.path, to: norm },
            "[migrate] UNIQUE collision — dropping the non-canonical row",
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
