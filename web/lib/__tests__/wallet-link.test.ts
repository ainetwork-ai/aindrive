import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the DB at a throwaway dir BEFORE importing db.js (module-level open()).
process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-walletlink-"));

const { db } = await import("../db.js");
const { linkWalletToAccount, WalletAlreadyLinkedError, resolveAccountForWallet, walletLoginAccount } = await import("../wallet.js");

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

describe("resolveAccountForWallet atomicity + self-heal", () => {
  const SYNTH_WALLET = "0xCafE000000000000000000000000000000000009";
  const addr = SYNTH_WALLET.toLowerCase();

  it("heals an orphan users row (synthetic email exists, no account_wallets link)", () => {
    // Simulate a crash-orphaned users row: minted with the deterministic
    // synthetic email but NO account_wallets link written.
    const orphanId = "w_orphan01";
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
      .run(orphanId, `${addr}@wallet.aindrive.local`, `wallet:${addr.slice(0, 10)}`, "x");

    // Must NOT throw on email-UNIQUE; must adopt the orphan and link it.
    const id = resolveAccountForWallet(SYNTH_WALLET);
    expect(id).toBe(orphanId);

    const link = db.prepare(
      "SELECT account_id, verified_via FROM account_wallets WHERE wallet_address = ?"
    ).get(addr) as { account_id: string; verified_via: string };
    expect(link.account_id).toBe(orphanId);
    expect(link.verified_via).toBe("payment");
  });

  it("is atomic: a fresh mint writes BOTH the users row and the link, or neither", () => {
    const fresh = "0xBeeF000000000000000000000000000000000010";
    const id = resolveAccountForWallet(fresh);
    const user = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
    const link = db.prepare("SELECT account_id FROM account_wallets WHERE wallet_address = ?")
      .get(fresh.toLowerCase()) as { account_id: string } | undefined;
    expect(user).toBeTruthy();
    expect(link?.account_id).toBe(id);
  });
});

describe("login_enabled provenance", () => {
  const NEWW = "0xD00d000000000000000000000000000000000011";

  it("a freshly minted placeholder account is login-enabled", () => {
    const id = resolveAccountForWallet(NEWW);
    const acct = walletLoginAccount(NEWW);
    expect(acct).toEqual({ accountId: id, loginEnabled: true });
  });

  it("returns null for an unknown wallet", () => {
    expect(walletLoginAccount("0x0000000000000000000000000000000000009999")).toBeNull();
  });

  it("a wallet linked to a real account is NOT login-enabled by default", () => {
    // u1 is a real (email) account seeded in the top-level beforeAll.
    const realWallet = "0xEeee000000000000000000000000000000000012";
    linkWalletToAccount("u1", realWallet, "siwe"); // authenticated link → verified_via siwe, login_enabled default 0
    expect(walletLoginAccount(realWallet)).toEqual({ accountId: "u1", loginEnabled: false });
  });
});
