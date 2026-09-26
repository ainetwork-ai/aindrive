import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the DB at a throwaway dir BEFORE importing db.js (it opens on import).
process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-sale-"));

const { db } = await import("../db.js");
const { paidAccessDenial, paidLocksForListing, paidLocksForPaths } = await import("../sale-access.js");

// Integration coverage for the paid carve-out read gate (PERMISSIONS_MATRIX.md
// §1, R-ACC-PAID-* / R-ACC-NEST-001). Drives real SQL over shares +
// payment_receipts, mirroring payout-db.test.ts.
const DRIVE = "drive-sale-it";
const OWNER = "u-owner";
const BUYER = "u-buyer";
const OTHER = "u-other";

function addShare(id: string, path: string, price: number | null, opts: { expires_at?: string; currency?: string; listed?: boolean } = {}) {
  db.prepare(
    "INSERT INTO shares (id, drive_id, path, role, token, price_usdc, currency, listed, expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(id, DRIVE, path, "viewer", "tok-" + id, price, opts.currency ?? "USDC", opts.listed === false ? 0 : 1, opts.expires_at ?? null);
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
  addShare("s-private", "private", 7, { listed: false });  // sold by private link only
  addShare("s-lessons", "Lessons", 5);                  // "ss": ẞ/ß/SS spellings are one name on APFS
  addShare("s-greek", "\u0390-notes", 5);              // ΐ: upper-cases to three code points
  addShare("s-course-lo", "course", 1);                 // two sales differing only in case
  addShare("s-course-up", "Course", 50);                //   (distinct folders on a case-sensitive agent)
  addReceipt("r-buyer-course", "course", BUYER);        // BUYER bought the 1 USDC one
  // Two offers on one folder: an old private-link sale, then a newer listed one.
  db.prepare("INSERT INTO shares (id, drive_id, path, role, token, price_usdc, currency, listed, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("s-dup-old", DRIVE, "album", "viewer", "tok-dup-old", 7, "USDC", 0, "2026-01-01 00:00:00");
  db.prepare("INSERT INTO shares (id, drive_id, path, role, token, price_usdc, currency, listed, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("s-dup-new", DRIVE, "album", "viewer", "tok-dup-new", 5, "USDC", 1, "2026-02-01 00:00:00");
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

  it("a sale covers every letter case of its path — a macOS agent serves Premium/ for premium/", () => {
    expect(paidAccessDenial(DRIVE, "PREMIUM/a.pdf", "viewer", OTHER)).toMatchObject({ gatePath: "premium" });
    expect(paidAccessDenial(DRIVE, "Premium/Secret/x.pdf", "viewer", BUYER)).toMatchObject({ gatePath: "premium/secret" });
    expect(paidAccessDenial(DRIVE, "Premium/a.pdf", "viewer", BUYER)).toBeNull(); // the buyer's receipt covers any spelling
    expect(paidLocksForListing(DRIVE, "", ["Premium"], "viewer", OTHER).Premium).toMatchObject({ shareId: "s-premium" });
  });

  it("case folding agrees with APFS on letters whose case maps change length (ẞ, ΐ)", () => {
    expect(paidAccessDenial(DRIVE, "Le\u1E9Eons/a.md", "viewer", OTHER)).toMatchObject({ gatePath: "Lessons" }); // Leẞons
    expect(paidAccessDenial(DRIVE, "LESSONS/a.md", "viewer", OTHER)).toMatchObject({ gatePath: "Lessons" });
    expect(paidAccessDenial(DRIVE, "\u0399\u0308\u0301-notes/a.md", "viewer", OTHER)).toMatchObject({ gatePath: "\u0390-notes" });
  });

  it("two sales differing only in case: each path is judged by its own sale", () => {
    expect(paidAccessDenial(DRIVE, "course/a.md", "viewer", BUYER)).toBeNull();
    expect(paidAccessDenial(DRIVE, "Course/a.md", "viewer", BUYER)).toMatchObject({ gatePath: "Course", price: 50 });
  });

  it("two sales on one folder: the paywall offers the listed one, so there is a Buy button", () => {
    expect(paidAccessDenial(DRIVE, "album/a.jpg", "viewer", OTHER)).toMatchObject({ shareId: "s-dup-new", listed: true, price: 5 });
    expect(paidLocksForListing(DRIVE, "", ["album"], "viewer", OTHER).album).toMatchObject({ shareId: "s-dup-new", listed: true });
  });

  it("the denial says whether the gate is listed — the paywall offers Buy only for a listed sale", () => {
    expect(paidAccessDenial(DRIVE, "premium/a.pdf", "viewer", OTHER)).toMatchObject({ listed: true });
    expect(paidAccessDenial(DRIVE, "private/a.pdf", "viewer", OTHER)).toMatchObject({ gatePath: "private", listed: false });
  });
});

describe("paidLocksForPaths — locks for rows at any paths (the grant listing)", () => {
  it("keys locks by full path and judges each path by the viewer's role there", () => {
    const roleAt = (p: string): "viewer" | "editor" => (p === "premium/secret" ? "editor" : "viewer");
    const locks = paidLocksForPaths(DRIVE, ["premium", "premium/secret", "private", "docs"], roleAt, OTHER);
    expect(locks.premium).toMatchObject({ price: 10, shareId: "s-premium", listed: true });
    expect(locks["premium/secret"]).toBeUndefined(); // an editor there manages it
    expect(locks.private).toMatchObject({ price: 7, listed: false });
    expect(locks.docs).toBeUndefined(); // free
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
