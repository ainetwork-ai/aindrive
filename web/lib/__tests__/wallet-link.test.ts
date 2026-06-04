import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the DB at a throwaway dir BEFORE importing db.js (module-level open()).
process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-walletlink-"));

const { db } = await import("../db.js");
const { linkWalletToAccount, WalletAlreadyLinkedError } = await import("../wallet.js");
const { resolveAccountForWallet } = await import("../wallet.js");

const WALLET = "0xABCdef0000000000000000000000000000000001";

describe("linkWalletToAccount", () => {
  beforeAll(() => {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
      .run("u1", "u1@example.com", "U1", "x");
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
      .run("u2", "u2@example.com", "U2", "x");
    db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)")
      .run("d1", "u1", "D1", "h", "s");
    // An anonymous receipt for WALLET, settled before any account linked it.
    db.prepare(
      "INSERT INTO payment_receipts (id, drive_id, path, wallet, tx_hash, amount_usdc, network) VALUES (?,?,?,?,?,?,?)"
    ).run("r1", "d1", "docs", WALLET.toLowerCase(), "0xtx1", 1.5, "base-sepolia");
  });

  it("inserts a lowercased link row and reclaims unattributed receipts", () => {
    const reclaimed = linkWalletToAccount("u1", WALLET, "siwe");
    expect(reclaimed).toBe(1);
    const row = db.prepare("SELECT account_id, wallet_address, verified_via FROM account_wallets WHERE wallet_address = ?")
      .get(WALLET.toLowerCase()) as { account_id: string; wallet_address: string; verified_via: string };
    expect(row).toMatchObject({ account_id: "u1", wallet_address: WALLET.toLowerCase(), verified_via: "siwe" });
    const receipt = db.prepare("SELECT account_id FROM payment_receipts WHERE id = ?").get("r1") as { account_id: string };
    expect(receipt.account_id).toBe("u1");
  });

  it("throws WalletAlreadyLinkedError when the wallet is taken by another account", () => {
    expect(() => linkWalletToAccount("u2", WALLET, "siwe")).toThrow(WalletAlreadyLinkedError);
  });

  it("is idempotent re-linking the same wallet to the same account (no duplicate, no throw)", () => {
    expect(() => linkWalletToAccount("u1", WALLET, "siwe")).not.toThrow();
    linkWalletToAccount("u1", WALLET, "siwe");
    const count = db.prepare("SELECT count(*) c FROM account_wallets WHERE wallet_address = ?")
      .get(WALLET.toLowerCase()) as { c: number };
    expect(count.c).toBe(1);
  });
});

describe("resolveAccountForWallet", () => {
  it("returns the account already linked to the wallet", () => {
    // u1 ↔ WALLET linked in the earlier suite.
    const id = resolveAccountForWallet(WALLET);
    expect(id).toBe("u1");
  });

  it("creates a placeholder account + link for an unknown wallet", () => {
    const fresh = "0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed";
    const id = resolveAccountForWallet(fresh);
    expect(id).toMatch(/^w_/); // placeholder id scheme
    const u = db.prepare("SELECT email, name, password_hash FROM users WHERE id = ?").get(id) as { email: string; name: string; password_hash: string };
    expect(u.email).toBe(`${fresh.toLowerCase()}@wallet.aindrive.local`);
    expect(u.password_hash.length).toBeGreaterThan(0);
    const link = db.prepare("SELECT account_id FROM account_wallets WHERE wallet_address = ?").get(fresh.toLowerCase()) as { account_id: string };
    expect(link.account_id).toBe(id);
  });

  it("is idempotent for the same unknown wallet (no duplicate account)", () => {
    const fresh = "0x0101010101010101010101010101010101010101";
    const a = resolveAccountForWallet(fresh);
    const b = resolveAccountForWallet(fresh);
    expect(a).toBe(b);
    const count = db.prepare("SELECT count(*) c FROM account_wallets WHERE wallet_address = ?").get(fresh.toLowerCase()) as { c: number };
    expect(count.c).toBe(1);
  });
});
