// The payment-network switch must flip chain + USDC address as ONE atomic set,
// and default to testnet on missing/garbage values (a typo must never point at
// real money). TOKEN_PRESETS is evaluated at module load, so each case re-imports
// the module under a stubbed env.
import { describe, it, expect, vi, afterEach } from "vitest";

async function loadWithNetwork(value: string | undefined) {
  vi.resetModules();
  if (value === undefined) vi.stubEnv("NEXT_PUBLIC_AINDRIVE_PAYMENT_NETWORK", "");
  else vi.stubEnv("NEXT_PUBLIC_AINDRIVE_PAYMENT_NETWORK", value);
  return await import("../payment-tokens");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("payment network switch", () => {
  it("defaults to testnet when unset", async () => {
    const m = await loadWithNetwork(undefined);
    expect(m.paymentNetwork()).toBe("testnet");
    expect(m.TOKEN_PRESETS.USDC.chain).toBe("base-sepolia");
    expect(m.TOKEN_PRESETS.USDC.asset).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(m.TOKEN_PRESETS.USDC.name).toBe("USDC");
  });

  it("falls back to testnet on garbage values (never mainnet by accident)", async () => {
    for (const v of ["production", "MAINNET", "main", "true", "1"]) {
      const m = await loadWithNetwork(v);
      expect(m.paymentNetwork(), `value=${v}`).toBe("testnet");
      expect(m.TOKEN_PRESETS.USDC.chain, `value=${v}`).toBe("base-sepolia");
    }
  });

  it("mainnet flips chain + address + EIP-712 name as one set", async () => {
    const m = await loadWithNetwork("mainnet");
    expect(m.paymentNetwork()).toBe("mainnet");
    expect(m.TOKEN_PRESETS.USDC.chain).toBe("base");
    expect(m.TOKEN_PRESETS.USDC.asset).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    // EIP-712 domain name differs per network (verified on-chain): wrong name
    // breaks signature verification, so this is load-bearing, not cosmetic.
    expect(m.TOKEN_PRESETS.USDC.name).toBe("USD Coin");
    expect(m.TOKEN_PRESETS.USDC.version).toBe("2");
  });

  it("USDC stays settleable and FANCO stays not-settleable in both modes", async () => {
    for (const v of [undefined, "mainnet"] as const) {
      const m = await loadWithNetwork(v);
      expect(m.isX402Settleable(m.TOKEN_PRESETS.USDC)).toBe(true);
      expect(m.isX402Settleable(m.TOKEN_PRESETS.FANCO)).toBe(false);
      expect(m.DEFAULT_TOKENS).toEqual([m.TOKEN_PRESETS.USDC]);
    }
  });
});

describe("stored-policy rebinding across a network flip", () => {
  // Saved while on testnet (the asset/chain/name a pre-flip server stored).
  const STORED_SEPOLIA_USDC = {
    symbol: "USDC", chain: "base-sepolia",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    name: "USDC", version: "2", decimals: 6,
  };
  const STORED_MAINNET_USDC = {
    symbol: "USDC", chain: "base",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    name: "USD Coin", version: "2", decimals: 6,
  };
  const CUSTOM_FANCO = {
    symbol: "FANCO", chain: "base", asset: "0x187e30921d687583e5e35f3dc6474f59a6e6fe5b",
    name: null, version: null, decimals: 18,
  };
  // A token that happens to be NAMED USDC but at an unknown address — an owner's
  // explicit custom choice, must never be rewritten.
  const IMPOSTOR_USDC = {
    symbol: "USDC", chain: "base", asset: "0x000000000000000000000000000000000000beef",
    name: "USDC", version: "1", decimals: 6,
  };

  it("a testnet-saved USDC policy follows the flip to mainnet (fund-misroute guard)", async () => {
    const m = await loadWithNetwork("mainnet");
    const tokens = m.resolveDriveTokens(JSON.stringify([STORED_SEPOLIA_USDC, CUSTOM_FANCO]));
    // USDC rebinds to the live network — the 402 must never quote base-sepolia
    // on a mainnet server (buyer would pay worthless testnet USDC for real content).
    expect(tokens[0]).toEqual(m.TOKEN_PRESETS.USDC);
    expect(tokens[0].chain).toBe("base");
    // Owner-chosen custom token is untouched.
    expect(tokens[1]).toEqual(CUSTOM_FANCO);
  });

  it("a mainnet-saved USDC policy follows the flip back to testnet", async () => {
    const m = await loadWithNetwork(undefined);
    const tokens = m.resolveDriveTokens(JSON.stringify([STORED_MAINNET_USDC]));
    expect(tokens[0]).toEqual(m.TOKEN_PRESETS.USDC);
    expect(tokens[0].chain).toBe("base-sepolia");
  });

  it("never rewrites a custom token that merely shares the USDC symbol", async () => {
    const m = await loadWithNetwork("mainnet");
    const tokens = m.resolveDriveTokens(JSON.stringify([IMPOSTOR_USDC]));
    expect(tokens[0]).toEqual(IMPOSTOR_USDC);
  });
});
