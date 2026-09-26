import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-wpay-"));
const { db } = await import("../db.js");
const { adoptOwnerPayoutWallet, loginWallets, listPayoutWallets, createDrive, setPayoutWallet } = await import("../drives");
const { linkWalletToAccount } = await import("../wallet");

db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("o1", "o1@example.com", "O1", "x");
const W = "0x" + "ab".repeat(20);

describe("sign-in wallet as payout wallet", () => {
  it("fills only drives without a payout wallet", async () => {
    const a = await createDrive("o1", "A");
    const b = await createDrive("o1", "B");
    setPayoutWallet(b.driveId, "", "0x" + "11".repeat(20));
    expect(adoptOwnerPayoutWallet("o1", W)).toBe(1);
    expect(listPayoutWallets(a.driveId)).toEqual([{ path: "", wallet: W }]);
    expect(listPayoutWallets(b.driveId)).toEqual([{ path: "", wallet: "0x" + "11".repeat(20) }]);
  });

  it("a drive with no payout wallet adopts the owner's sign-in wallet when a sale needs one", async () => {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("o2", "o2@example.com", "O2", "x");
    const d = await createDrive("o2", "D");
    const { payoutWalletFor } = await import("../drives");
    expect(payoutWalletFor(d.driveId, "a/b")).toBe(null);
    const W2 = "0x" + "cd".repeat(20);
    db.prepare("INSERT INTO account_wallets (id, account_id, wallet_address, verified_via, login_enabled) VALUES ('x2','o2',?, 'siwe', 1)").run(W2);
    expect(payoutWalletFor(d.driveId, "a/b")).toBe(W2);
    expect(listPayoutWallets(d.driveId)).toEqual([{ path: "", wallet: W2 }]);
  });

  it("lists login-enabled wallets and gives new drives the sign-in wallet", async () => {
    linkWalletToAccount("o1", W, "siwe", true);
    expect(loginWallets("o1")).toEqual([W]);
    const c = await createDrive("o1", "C");
    expect(listPayoutWallets(c.driveId)).toEqual([{ path: "", wallet: W }]);
  });
});
