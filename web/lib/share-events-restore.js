// After a restore of the SQLite database from a backup (or a roll-forward after a
// rollback to a release that did not write the feed), the change feed must not
// let a product keep what the restore took away.
//
// What goes wrong without this: the restored `sqlite_sequence` hands out the
// same `seq` numbers again, and `share_event_versions` the same versions. A
// product that read the feed after the backup was taken holds a cursor
// (`ev_<seq>`) and per-resource versions from that lost stretch. listShareEvents
// answers such a cursor with `gap: true` only while it is still AHEAD of what
// the restored feed has issued; as soon as new changes pass it, the product
// reads on from there — it never re-lists (so a grant the restore removed stays
// in its list), it skips the new events below its cursor, and the reducer
// (`applyEvents`, contract) drops every event whose version is not above the
// one it already holds, a revoke included.
//
// The fix, run once with the server stopped, after the database is put back:
//   • the next `seq` jumps past anything issued before (max(current, now in ms)),
//   • every account's floor (`share_event_floors.pruned_to`) is raised to that
//     point, so every cursor from before the restore answers `gap: true` → the
//     product re-lists from the source tables and keeps polling from there,
//   • every resource version jumps by VERSION_JUMP, so later events outrank
//     anything a product saw before the restore.
// Idempotent in effect (running it twice only jumps further). Nothing else is
// touched; grants, drives and shares are what the backup says.

export const VERSION_JUMP = 1_000_000;

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{ now?: number, dryRun?: boolean }} [opts]
 * @returns {{ base: number, previousMaxSeq: number, recipients: number, resources: number, dryRun: boolean }}
 */
export function resetShareEventCursors(db, opts = {}) {
  const now = Math.floor(opts.now ?? Date.now());
  const previousMaxSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM share_events").get().m;
  const seqRow = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'share_events'").get();
  const base = Math.max(previousMaxSeq, seqRow?.seq ?? 0, now);
  const recipients = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  const resources = db.prepare("SELECT COUNT(*) AS n FROM share_event_versions").get().n;
  if (!opts.dryRun) {
    db.transaction(() => {
      if (seqRow) db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'share_events'").run(base);
      else db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('share_events', ?)").run(base);
      db.prepare(
        "INSERT INTO share_event_floors (recipient_user_id, pruned_to) SELECT id, ? FROM users WHERE true " +
          "ON CONFLICT(recipient_user_id) DO UPDATE SET pruned_to = max(share_event_floors.pruned_to, excluded.pruned_to)",
      ).run(base);
      db.prepare("UPDATE share_event_versions SET version = version + ?").run(VERSION_JUMP);
    })();
  }
  return { base, previousMaxSeq, recipients, resources, dryRun: !!opts.dryRun };
}
