import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the DB at a throwaway dir BEFORE importing db.js (it opens on import).
process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-payout-"));

const { db } = await import("../db.js");
const {
  setPayoutWallet,
  listPayoutWallets,
  payoutWalletFor,
  getDriveRootPayoutWallet,
} = await import("../drives.js");

// Integration coverage for the path-scoped payout helpers: unlike payout.test.ts
// (which tests the pure resolver in isolation), this drives the real SQL —
// INSERT…ON CONFLICT, DELETE, and the ORDER BY that feeds the resolver — so a
// schema or query regression is caught, not just a logic one.
const DRIVE = "drive-payout-it";
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xcccccccccccccccccccccccccccccccccccccccc";

beforeAll(() => {
  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
    .run("u1", "owner@example.com", "Owner", "x");
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)")
    .run(DRIVE, "u1", "Drive", "h", "s");
});

describe("path-scoped payout (DB)", () => {
  it("sets and lists wallets, ordered by path", () => {
    setPayoutWallet(DRIVE, "", A);
    setPayoutWallet(DRIVE, "docs", B);
    setPayoutWallet(DRIVE, "docs/q3", C);
    expect(listPayoutWallets(DRIVE)).toEqual([
      { path: "", wallet: A },
      { path: "docs", wallet: B },
      { path: "docs/q3", wallet: C },
    ]);
  });

  it("resolves the nearest ancestor wallet", () => {
    expect(payoutWalletFor(DRIVE, "docs/q3/report.pdf")).toBe(C); // deepest
    expect(payoutWalletFor(DRIVE, "docs/readme.md")).toBe(B);     // parent
    expect(payoutWalletFor(DRIVE, "photos/x.jpg")).toBe(A);       // root fallback
  });

  it("ON CONFLICT replaces a path's wallet instead of duplicating", () => {
    setPayoutWallet(DRIVE, "docs", A);
    expect(listPayoutWallets(DRIVE).filter((r) => r.path === "docs")).toEqual([
      { path: "docs", wallet: A },
    ]);
    expect(payoutWalletFor(DRIVE, "docs/q3/x")).toBe(C); // child override still wins
  });

  it("clearing a path falls back to the inherited wallet", () => {
    setPayoutWallet(DRIVE, "docs/q3", null);
    expect(getDriveRootPayoutWallet(DRIVE)).toBe(A);
    expect(payoutWalletFor(DRIVE, "docs/q3/x")).toBe(A); // q3 gone → docs(A)… docs===A
  });

  it("clearing the root leaves uncovered paths with no wallet", () => {
    setPayoutWallet(DRIVE, "", null);
    setPayoutWallet(DRIVE, "docs", null);
    expect(getDriveRootPayoutWallet(DRIVE)).toBeNull();
    expect(payoutWalletFor(DRIVE, "anything")).toBeNull();
  });
});
