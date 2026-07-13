import { describe, it, expect } from "vitest";
import { isWalletOnlyEmail, walletDisplayLabel } from "../../shared/wallet-display";

const ADDR = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

describe("wallet-display", () => {
  it("detects the synthetic wallet email (case-insensitive)", () => {
    expect(isWalletOnlyEmail(`${ADDR}@wallet.aindrive.local`)).toBe(true);
    expect(isWalletOnlyEmail(`${ADDR.toUpperCase()}@WALLET.AINDRIVE.LOCAL`)).toBe(true);
    expect(isWalletOnlyEmail("real@example.com")).toBe(false);
  });

  it("truncates the wallet address for a wallet-only email", () => {
    expect(walletDisplayLabel(`${ADDR}@wallet.aindrive.local`)).toBe("0x7099…79c8");
  });

  it("returns name (then email) for a real account", () => {
    expect(walletDisplayLabel("real@example.com", "Alice")).toBe("Alice");
    expect(walletDisplayLabel("real@example.com")).toBe("real@example.com");
  });

  it("ignores the wallet:… name and uses the address for wallet-only accounts", () => {
    expect(walletDisplayLabel(`${ADDR}@wallet.aindrive.local`, "wallet:0x70997970")).toBe("0x7099…79c8");
  });
});
