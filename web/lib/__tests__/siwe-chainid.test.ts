import { describe, it, expect } from "vitest";
import { SiweMessage } from "siwe";

// challengeMessage needs env.publicUrl; set a deterministic one before import.
process.env.AINDRIVE_PUBLIC_URL = "https://drive.example.test";
process.env.NEXT_PUBLIC_AINDRIVE_PAYMENT_NETWORK = "testnet";

const { challengeMessage } = await import("../wallet.js");
const { activeChainId } = await import("../payment-tokens.js");

describe("SIWE challenge chainId", () => {
  it("activeChainId is Base Sepolia on testnet, Base mainnet on mainnet", () => {
    expect(activeChainId()).toBe(84532);
  });

  it("challengeMessage emits the active Base chainId, not Ethereum mainnet (1)", () => {
    const msg = challengeMessage("abcd1234efgh", "0x0000000000000000000000000000000000000001");
    const parsed = new SiweMessage(msg);
    expect(parsed.chainId).toBe(84532);
  });
});
