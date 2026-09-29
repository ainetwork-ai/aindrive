// drive_org_shares is added by lib/db.js's bootstrap: to a DB from before
// organizations existed (with SSO rows in it), and again on every later boot
// without error or data loss.
import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "aindrive-org-schema-"));
process.env.AINDRIVE_DATA_DIR = dataDir;

type G = { __aindrive_db?: unknown; __aindrive_drizzle_db?: unknown };
/** A fresh import of db.js = one more server boot on the same file. */
async function boot() {
  const g = globalThis as G;
  (g.__aindrive_db as { close?: () => void } | undefined)?.close?.();
  delete g.__aindrive_db;
  delete g.__aindrive_drizzle_db;
  vi.resetModules();
  return (await import("../db.js")).db;
}

describe("drive_org_shares schema", () => {
  it("is added to a pre-organizations DB and survives repeated boots", async () => {
    // Boot 1 builds today's schema; drop the organizations parts to get the
    // shape production had before this feature, with an SSO membership in it.
    let db = await boot();
    db.exec("DROP INDEX IF EXISTS idx_sso_memberships_org_user; DROP TABLE IF EXISTS drive_org_shares;");
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES ('u1', 'u1@e.com', 'U', 'x')").run();
    db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES ('d1', 'u1', 'D', 'h', 's')").run();
    db.prepare(`INSERT INTO sso_memberships (issuer, org_id, subject, user_id, org_slug, org_name, status, applied_version, updated_at)
                VALUES ('https://sso.test', 'org_1', 'acc_1', 'u1', 'comcom', 'ComCom', 'active', 1, 1)`).run();

    db = await boot();
    const cols = (db.prepare("PRAGMA table_info(drive_org_shares)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(["drive_id", "issuer", "org_id", "role", "created_by", "created_at", "updated_at"]);
    const idx = (db.prepare("PRAGMA index_list(sso_memberships)").all() as { name: string }[]).map((i) => i.name);
    expect(idx).toContain("idx_sso_memberships_org_user");
    db.prepare("INSERT INTO drive_org_shares (drive_id, issuer, org_id, role, created_by, created_at, updated_at) VALUES ('d1', 'https://sso.test', 'org_1', 'viewer', 'operator', 1, 1)").run();

    for (let i = 0; i < 2; i++) db = await boot();
    expect(db.prepare("SELECT drive_id, role FROM drive_org_shares").all()).toEqual([{ drive_id: "d1", role: "viewer" }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sso_memberships").get()).toEqual({ n: 1 });
    // Only viewer | editor; a drive_org_shares row goes with its drive.
    expect(() => db.prepare("INSERT INTO drive_org_shares (drive_id, issuer, org_id, role, created_by, created_at, updated_at) VALUES ('d1', 'i', 'o', 'owner', 't', 1, 1)").run()).toThrow(/CHECK/);
    db.prepare("DELETE FROM drives WHERE id = 'd1'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM drive_org_shares").get()).toEqual({ n: 0 });
  });

  it("an unrelated reader of the file sees the same table (plain SQLite, no drizzle entry needed)", () => {
    const raw = new Database(join(dataDir, "data.sqlite"), { readonly: true });
    try {
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'drive_org_shares'").get()).toEqual({ name: "drive_org_shares" });
    } finally { raw.close(); }
  });
});
