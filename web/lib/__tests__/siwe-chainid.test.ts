import { describe, it, expect, vi, afterEach } from "vitest";
import { SiweMessage } from "siwe";

// challengeMessage and activeChainId read env at module load, so each case
// re-imports under a stubbed env (see payment-network.test.ts for the same
// convention).
async function loadWithTestnetEnv() {
  vi.resetModules();
  vi.stubEnv("AINDRIVE_PUBLIC_URL", "https://drive.example.test");
  vi.stubEnv("NEXT_PUBLIC_AINDRIVE_PAYMENT_NETWORK", "testnet");
  const { challengeMessage } = await import("../wallet.js");
  const { activeChainId } = await import("../payment-tokens.js");
  return { challengeMessage, activeChainId };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("SIWE challenge chainId", () => {
  it("activeChainId is Base Sepolia on testnet, Base mainnet on mainnet", async () => {
    const { activeChainId } = await loadWithTestnetEnv();
    expect(activeChainId()).toBe(84532);
  });

  it("challengeMessage emits the active Base chainId, not Ethereum mainnet (1)", async () => {
    const { challengeMessage } = await loadWithTestnetEnv();
    const msg = challengeMessage("abcd1234efgh", "0x0000000000000000000000000000000000000001");
    const parsed = new SiweMessage(msg);
    expect(parsed.chainId).toBe(84532);
  });
});
