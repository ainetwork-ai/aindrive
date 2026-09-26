import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-migrate-paths-"));

const { db } = await import("../db.js");
const { runNormalizePathsMigration } = await import("../migrations/0001-normalize-paths.js");

// Rows written before paths were NFC may hold the NFD spelling a macOS agent
// reported. The boot migration rewrites every stored path column to the
// canonical form, and where two spellings of one path collide it never lowers
// anyone's access (upgrade-only, docs/PERMISSIONS.md).
const DRIVE = "drive-migrate-paths";
const OWNER = "u-mp-owner";
const MEMBER = "u-mp-member";
const NFC = "제주 앨범".normalize("NFC");
const NFD = NFC.normalize("NFD");
const pathOf = (table: string, id: string) =>
  (db.prepare(`SELECT path FROM ${table} WHERE id = ?`).get(id) as { path: string } | undefined)?.path;

beforeAll(() => {
  for (const [id, email] of [[OWNER, "mpo@e.com"], [MEMBER, "mpm@e.com"]]) {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run(id, email, "N", "x");
  }
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)")
    .run(DRIVE, OWNER, "D", "h", "s");
  db.prepare("INSERT INTO shares (id, drive_id, path, role, token, price_usdc, currency, listed) VALUES (?,?,?,?,?,?,?,?)")
    .run("s-mp", DRIVE, NFD, "viewer", "tok-mp", 1, "USDC", 1);
  db.prepare("INSERT INTO payment_receipts (id, drive_id, path, wallet, tx_hash, amount_usdc, network, share_id, account_id) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("r-mp", DRIVE, NFD, "0xw", "tx-mp", 1, "base", "s-mp", MEMBER);
  db.prepare("INSERT INTO drive_payout_wallets (id, drive_id, path, wallet) VALUES (?,?,?,?)")
    .run("p-mp", DRIVE, NFD, "0xpayout");
  // Two payout wallets for one folder, one per spelling.
  db.prepare("INSERT INTO drive_payout_wallets (id, drive_id, path, wallet) VALUES (?,?,?,?)")
    .run("p-mp-nfc", DRIVE, "사진".normalize("NFC"), "0xcanonical");
  db.prepare("INSERT INTO drive_payout_wallets (id, drive_id, path, wallet) VALUES (?,?,?,?)")
    .run("p-mp-nfd", DRIVE, "사진".normalize("NFD"), "0xother");
  db.prepare("INSERT INTO drive_invites (id, drive_id, email, path, role) VALUES (?,?,?,?,?)")
    .run("i-mp", DRIVE, "later@e.com", NFD, "viewer");
  // Two grants for one folder, one per spelling: the NFD one is the higher role.
  db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)")
    .run("m-mp-nfc", DRIVE, MEMBER, NFC, "viewer");
  db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)")
    .run("m-mp-nfd", DRIVE, MEMBER, NFD, "editor");
  runNormalizePathsMigration();
});

describe("0001-normalize-paths — stored paths become NFC", () => {
  it.each([
    ["shares", "s-mp"],
    ["payment_receipts", "r-mp"],
    ["drive_payout_wallets", "p-mp"],
    ["drive_invites", "i-mp"],
  ])("%s", (table, id) => {
    expect(pathOf(table, id)).toBe(NFC);
  });

  it("two grants on one folder merge into one, keeping the higher role", () => {
    const rows = db.prepare("SELECT path, role FROM drive_members WHERE drive_id = ? AND user_id = ?").all(DRIVE, MEMBER);
    expect(rows).toEqual([{ path: NFC, role: "editor" }]);
  });

  it("two payout wallets on one folder: the canonical row's wallet is kept (both are logged)", () => {
    const rows = db.prepare("SELECT path, wallet FROM drive_payout_wallets WHERE drive_id = ? AND path = ?").all(DRIVE, "사진".normalize("NFC"));
    expect(rows).toEqual([{ path: "사진".normalize("NFC"), wallet: "0xcanonical" }]);
  });

  it("is idempotent", () => {
    expect(runNormalizePathsMigration()).toMatchObject({ changed: 0, dropped: 0 });
  });
});
