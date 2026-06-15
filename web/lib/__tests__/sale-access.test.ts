import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the DB at a throwaway dir BEFORE importing db.js (it opens on import).
process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-sale-"));

const { db } = await import("../db.js");
const { paidAccessDenial, paidLocksForListing } = await import("../sale-access.js");

// Integration coverage for the paid carve-out read gate (PERMISSIONS_MATRIX.md
// §1, R-ACC-PAID-* / R-ACC-NEST-001). Drives real SQL over shares +
// payment_receipts, mirroring payout-db.test.ts.
const DRIVE = "drive-sale-it";
const OWNER = "u-owner";
const BUYER = "u-buyer";
const OTHER = "u-other";

function addShare(id: string, path: string, price: number | null, opts: { expires_at?: string; currency?: string } = {}) {
  db.prepare(
    "INSERT INTO shares (id, drive_id, path, role, token, price_usdc, currency, listed, expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(id, DRIVE, path, "viewer", "tok-" + id, price, opts.currency ?? "USDC", 1, opts.expires_at ?? null);
}
function addReceipt(id: string, path: string, accountId: string) {
  db.prepare(
    "INSERT INTO payment_receipts (id, drive_id, path, wallet, tx_hash, amount_usdc, network, share_id, account_id) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(id, DRIVE, path, "0xwallet-" + id, "tx-" + id, 10, "base", null, accountId);
}

beforeAll(() => {
  for (const [id, email] of [[OWNER, "o@e.com"], [BUYER, "b@e.com"], [OTHER, "t@e.com"]]) {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run(id, email, "N", "x");
  }
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)")
    .run(DRIVE, OWNER, "D", "h", "s");
  addShare("s-premium", "premium", 10);              // paid folder
  addShare("s-secret", "premium/secret", 50);         // deeper, separately priced
  addShare("s-expired", "old", 5, { expires_at: "2020-01-01T00:00:00Z" }); // expired sale
  addReceipt("r-buyer-premium", "premium", BUYER);    // BUYER bought /premium only
});

describe("paidAccessDenial — paid carve-out read gate (DB)", () => {
  it("R-ACC-FREE-001: free path returns null (no denial)", () => {
    expect(paidAccessDenial(DRIVE, "docs/readme.md", "viewer", BUYER)).toBeNull();
  });

  it("R-ACC-PAID-001: paid path, viewer without entitlement → denied with the gate share", () => {
    const d = paidAccessDenial(DRIVE, "premium/a.pdf", "viewer", OTHER);
    expect(d).not.toBeNull();
    expect(d).toMatchObject({ gatePath: "premium", shareId: "s-premium", price: 10, currency: "USDC" });
  });

  it("R-ACC-PAID-003: paid path, buyer with a covering receipt → null", () => {
    expect(paidAccessDenial(DRIVE, "premium/a.pdf", "viewer", BUYER)).toBeNull();
  });

  it("R-ACC-PAID-002: editor+ bypasses the paywall (manager) even with no receipt", () => {
    expect(paidAccessDenial(DRIVE, "premium/a.pdf", "editor", OTHER)).toBeNull();
    expect(paidAccessDenial(DRIVE, "premium/a.pdf", "owner", OTHER)).toBeNull();
  });

  it("R-ACC-NEST-001: buying the parent does NOT unlock a deeper, separately-priced child", () => {
    // BUYER has a receipt at /premium but the nearest gate for /premium/secret/* is
    // /premium/secret (price 50) — a different sale they did not buy.
    const d = paidAccessDenial(DRIVE, "premium/secret/x.pdf", "viewer", BUYER);
    expect(d).not.toBeNull();
    expect(d).toMatchObject({ gatePath: "premium/secret", price: 50 });
  });

  it("R-ACC-PAID-001: nearest-ancestor gate — /premium/a uses /premium, not the deeper /premium/secret", () => {
    const d = paidAccessDenial(DRIVE, "premium/a.pdf", "viewer", OTHER);
    expect(d).toMatchObject({ gatePath: "premium" });
  });

  it("no account (unauthenticated payer) on a paid path → denied", () => {
    expect(paidAccessDenial(DRIVE, "premium/a.pdf", "viewer", null)).not.toBeNull();
  });

  it("a receipt for a different account does not entitle", () => {
    expect(paidAccessDenial(DRIVE, "premium/x", "viewer", OTHER)).not.toBeNull();
  });

  it("an expired sale no longer gates — path falls back to free", () => {
    expect(paidAccessDenial(DRIVE, "old/x.pdf", "viewer", OTHER)).toBeNull();
  });
});

describe("paidLocksForListing — per-entry lock annotations for a folder listing (R-VIS-PAID-001)", () => {
  it("locks paid children for a non-entitled viewer; free children unlocked", () => {
    const locks = paidLocksForListing(DRIVE, "", ["premium", "docs", "old"], "viewer", OTHER);
    expect(locks.premium).toMatchObject({ price: 10, currency: "USDC", shareId: "s-premium", listed: true });
    expect(locks.docs).toBeUndefined(); // free
    expect(locks.old).toBeUndefined(); // expired sale → free
  });

  it("nested: buyer of the parent still sees a deeper, separately-priced child locked (R-NEST)", () => {
    const locks = paidLocksForListing(DRIVE, "premium", ["secret", "a.txt"], "viewer", BUYER);
    expect(locks.secret).toMatchObject({ price: 50, currency: "USDC", shareId: "s-secret" }); // deeper sale, not bought
    expect(locks["a.txt"]).toBeUndefined(); // covered by the /premium receipt
  });

  it("editor+ sees no locks (managers)", () => {
    expect(paidLocksForListing(DRIVE, "", ["premium"], "editor", OTHER)).toEqual({});
  });

  it("no account (anon) — paid children locked", () => {
    const locks = paidLocksForListing(DRIVE, "", ["premium"], "viewer", null);
    expect(locks.premium).toMatchObject({ price: 10, currency: "USDC", shareId: "s-premium", listed: true });
  });
});
