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

  it("lists login-enabled wallets and gives new drives the sign-in wallet", async () => {
    linkWalletToAccount("o1", W, "siwe", true);
    expect(loginWallets("o1")).toEqual([W]);
    const c = await createDrive("o1", "C");
    expect(listPayoutWallets(c.driveId)).toEqual([{ path: "", wallet: W }]);
  });
});
