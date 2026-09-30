// After a database restore the change feed must make every product re-list and
// must outrank what products saw after the backup (lib/share-events-restore.js).
import { describe, it, expect } from "vitest";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "aindrive-restore-"));
process.env.AINDRIVE_DATA_DIR = dir;
process.env.AINDRIVE_PUBLIC_URL = "https://drive.test";

const { db } = await import("../db.js");
const core = await import("../share-events-core.js");
const ev = await import("../share-events");
const { resetShareEventCursors, VERSION_JUMP } = await import("../share-events-restore.js");

db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)").run("u-owner", "owner@test", "Owner", "x");
db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)").run("u-carol", "carol@test", "Carol", "x");
db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?, ?, ?, ?, ?)").run("d1", "u-owner", "d1", "h", "s");

/** One row as a plain record (better-sqlite3 types rows as unknown). */
const row = (sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as Record<string, number>;
const share = (type: string, path = "") => core.recordShareEvent({ driveId: "d1", path, type, recipients: ["u-carol"] });
const R = core.resourceKey("d1", "");

/** A product: cursor + per-resource versions + a cache; re-lists on gap (keeping its versions, the worst case). */
function consumer() {
  return { cursor: null as string | null, versions: new Map<string, number>(), cache: new Set<string>() };
}
function poll(c: ReturnType<typeof consumer>, truth: string[]) {
  const page = ev.listShareEvents("u-carol", c.cursor);
  if (page.gap) c.cache = new Set(truth);
  for (const e of page.events) {
    const have = c.versions.get(e.resourceId) ?? -1;
    if (e.version <= have) continue;
    c.versions.set(e.resourceId, e.version);
    if (e.type === "file.shared") c.cache.add(e.resourceId); else c.cache.delete(e.resourceId);
  }
  c.cursor = page.nextCursor;
  return page;
}

describe("share events after a database restore", () => {
  it("without the reset a product keeps a grant the restore removed and misses a later revoke; with it, it re-lists and applies the revoke", () => {
    share("file.shared"); // before the backup
    const backup = join(dir, "backup.sqlite");
    db.pragma("wal_checkpoint(TRUNCATE)");
    copyFileSync(join(dir, "data.sqlite"), backup);
    const beforeBackupVersion = row("SELECT version FROM share_event_versions WHERE resource_key = ?", R).version;

    // after the backup: revoke + share again; the product follows
    const p = consumer();
    poll(p, []);
    share("file.revoked"); share("file.shared"); share("file.revoked"); share("file.shared");
    poll(p, []);
    expect([...p.cache]).toEqual([R]);
    const seen = p.versions.get(R)!;
    expect(seen).toBe(beforeBackupVersion + 4);

    // "restore": put the backup's rows back into the live database (same connection)
    const snap = new (db.constructor as any)(backup, { readonly: true });
    db.transaction(() => {
      for (const t of ["share_events", "share_event_versions", "share_event_floors", "sqlite_sequence"]) {
        db.prepare(`DELETE FROM ${t}`).run();
        const rows = snap.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[];
        for (const r of rows) {
          const cols = Object.keys(r);
          db.prepare(`INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...cols.map((k) => r[k]));
        }
      }
    })();
    snap.close();
    // the restore lost the last share: carol has no grant now — the source truth is []
    const withoutReset = structuredClone({ cursor: p.cursor, versions: [...p.versions], cache: [...p.cache] });

    // (a) no reset: new changes pass the product's cursor before it polls again
    const bad = { cursor: withoutReset.cursor, versions: new Map(withoutReset.versions), cache: new Set(withoutReset.cache) };
    const savepoint = row("SELECT seq FROM sqlite_sequence WHERE name = 'share_events'").seq;
    db.exec("SAVEPOINT a");
    // other accounts' changes move the global seq past the product's cursor (the owner's own file here)…
    for (let i = 0; i < 6; i++) core.recordShareEvent({ driveId: "d1", path: `other-${i}.md`, type: "file.shared", recipients: ["u-owner"] });
    // …then carol is granted R again and revoked: versions restart below what the product holds
    share("file.shared"); share("file.revoked");
    const pageBad = poll(bad, []);
    expect(pageBad.events.map((e) => e.type)).toEqual(["file.shared", "file.revoked"]);
    expect(pageBad.gap).toBe(false);
    expect([...bad.cache]).toEqual([R]); // stale: the product still lists a grant that was revoked
    db.exec("ROLLBACK TO a"); db.exec("RELEASE a");
    db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'share_events'").run(savepoint);

    // (b) with the reset
    const r = resetShareEventCursors(db, { now: 1_800_000_000_000 });
    expect(r.base).toBe(1_800_000_000_000);
    const good = { cursor: withoutReset.cursor, versions: new Map(withoutReset.versions), cache: new Set(withoutReset.cache) };
    share("file.shared");
    const first = poll(good, []); // truth at this moment: carol has R again
    expect(first.gap).toBe(true);
    const seqs = row("SELECT seq FROM share_events WHERE recipient_user_id = 'u-carol' ORDER BY seq DESC LIMIT 1").seq;
    expect(seqs).toBeGreaterThan(1_800_000_000_000);
    expect(row("SELECT version FROM share_event_versions WHERE resource_key = ?", R).version).toBeGreaterThan(seen);
    share("file.revoked");
    poll(good, []);
    expect([...good.cache]).toEqual([]); // the revoke is applied
    expect(good.versions.get(R)).toBeGreaterThan(VERSION_JUMP);
  });

  it("dry run changes nothing; a second run only jumps further", () => {
    const before = row("SELECT seq FROM sqlite_sequence WHERE name = 'share_events'").seq;
    const dry = resetShareEventCursors(db, { dryRun: true, now: 1 });
    expect(dry.dryRun).toBe(true);
    expect(row("SELECT seq FROM sqlite_sequence WHERE name = 'share_events'").seq).toBe(before);
    const again = resetShareEventCursors(db, { now: 1 });
    expect(again.base).toBe(before);
    expect(row("SELECT pruned_to FROM share_event_floors WHERE recipient_user_id = 'u-owner'").pruned_to).toBe(before);
  });

  it("a new account (no floor row) and a fresh cursor still work", () => {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)").run("u-new", "new@test", "New", "x");
    const page = ev.listShareEvents("u-new", null);
    expect(page.events).toEqual([]);
    expect(page.gap).toBe(false);
  });
});
