import { describe, it, expect } from "vitest";
import {
  DEFAULT_TOKENS,
  TOKEN_PRESETS,
  resolveDriveTokens,
  parseTokenPolicy,
  isX402Settleable,
  toCaip2Network,
  toAtomicAmount,
} from "../payment-tokens";

describe("resolveDriveTokens", () => {
  it("returns DEFAULT_TOKENS for NULL policy", () => {
    expect(resolveDriveTokens(null)).toEqual(DEFAULT_TOKENS);
  });

  it("returns DEFAULT_TOKENS for unparsable/invalid JSON", () => {
    expect(resolveDriveTokens("not json {{{")).toEqual(DEFAULT_TOKENS);
    expect(resolveDriveTokens("[]")).toEqual(DEFAULT_TOKENS);
    expect(resolveDriveTokens('{"symbol":"USDC"}')).toEqual(DEFAULT_TOKENS);
    expect(resolveDriveTokens('[{"symbol":"USDC"}]')).toEqual(DEFAULT_TOKENS);
  });

  it("returns the parsed tokens for a valid JSON policy", () => {
    const policy = [TOKEN_PRESETS.USDC, { ...TOKEN_PRESETS.FANCO, asset: "0x0000000000000000000000000000000000000001" }];
    expect(resolveDriveTokens(JSON.stringify(policy))).toEqual(policy);
  });
});

// Stored policies predate the transferMethod field; reads must infer it from
// the legacy rule (full EIP-712 domain ⇒ eip3009) so old rows keep settling
// exactly as they did, while everything else gains the permit2 path.
describe("transferMethod", () => {
  it("infers eip3009 for legacy stored tokens with name+version", () => {
    const legacy = JSON.stringify([{ symbol: "USDC", chain: "base", asset: "0xA", name: "USD Coin", version: "2", decimals: 6 }]);
    expect(resolveDriveTokens(legacy)[0].transferMethod).toBe("eip3009");
  });

  it("infers permit2 for legacy stored tokens without version", () => {
    const legacy = JSON.stringify([{ symbol: "FAN", chain: "base", asset: "0xB", name: "Fan", version: null, decimals: 18 }]);
    expect(resolveDriveTokens(legacy)[0].transferMethod).toBe("permit2");
  });

  it("keeps an explicit stored method over inference", () => {
    const stored = JSON.stringify([{ symbol: "FAN", chain: "base", asset: "0xB", name: "Fan", version: "1", decimals: 18, transferMethod: "permit2" }]);
    expect(resolveDriveTokens(stored)[0].transferMethod).toBe("permit2");
  });

  it("rejects an invalid method value", () => {
    const bad = JSON.stringify([{ symbol: "X", chain: "base", asset: "0xC", name: null, version: null, decimals: 18, transferMethod: "magic" }]);
    expect(parseTokenPolicy(bad)).toBeNull();
  });

  // [adv-review CRITICAL-1] sub-2-decimal tokens would make toAtomicAmount's
  // 10^(decimals-2) BigInt exponent negative → RangeError on every 402 quote.
  it("rejects tokens with decimals < 2 (atomic scaling floor)", () => {
    const zero = JSON.stringify([{ symbol: "Z", chain: "base", asset: "0xC", name: null, version: null, decimals: 0 }]);
    const one = JSON.stringify([{ symbol: "O", chain: "base", asset: "0xC", name: null, version: null, decimals: 1 }]);
    expect(parseTokenPolicy(zero)).toBeNull();
    expect(parseTokenPolicy(one)).toBeNull();
  });

  it("presets carry explicit methods", () => {
    expect(TOKEN_PRESETS.USDC.transferMethod).toBe("eip3009");
    expect(TOKEN_PRESETS.FANCO.transferMethod).toBe("permit2");
  });
});

describe("isX402Settleable (method-aware)", () => {
  it("permit2 token settles with asset only", () => {
    expect(isX402Settleable({ name: null, version: null, asset: "0xB", transferMethod: "permit2" })).toBe(true);
  });

  it("permit2 token without asset does not settle", () => {
    expect(isX402Settleable({ name: null, version: null, asset: "", transferMethod: "permit2" })).toBe(false);
  });

  it("eip3009 token still needs the full EIP-712 domain", () => {
    expect(isX402Settleable({ name: "T", version: null, asset: "0xB", transferMethod: "eip3009" })).toBe(false);
    expect(isX402Settleable({ name: "T", version: "1", asset: "0xB", transferMethod: "eip3009" })).toBe(true);
  });
});

describe("toCaip2Network", () => {
  it("maps base and base-sepolia", () => {
    expect(toCaip2Network("base")).toBe("eip155:8453");
    expect(toCaip2Network("base-sepolia")).toBe("eip155:84532");
  });

  it("throws on an unknown chain", () => {
    expect(() => toCaip2Network("optimism")).toThrow();
  });
});

// [rev2-B] exact digit strings — float 10**decimals scaling would lose
// precision at 18 decimals and emit "1e+21"-style exponents above 1000.
describe("toAtomicAmount", () => {
  it("1.1 @ 18 decimals", () => {
    const s = toAtomicAmount(1.1, 18);
    expect(s).toBe("1100000000000000000");
    expect(s).not.toContain("e+");
  });

  it("1000 @ 18 decimals (past Number exponent threshold)", () => {
    const s = toAtomicAmount(1000, 18);
    expect(s).toBe("1" + "0".repeat(21));
    expect(s).not.toContain("e+");
  });

  it("0.01 @ 18 decimals (past MAX_SAFE_INTEGER)", () => {
    const s = toAtomicAmount(0.01, 18);
    expect(s).toBe("10000000000000000");
    expect(s).not.toContain("e+");
  });

  it("5 @ 6 decimals (USDC)", () => {
    const s = toAtomicAmount(5, 6);
    expect(s).toBe("5000000");
    expect(s).not.toContain("e+");
  });

  it("throws a clear error below the 2-decimal floor (validators must catch first)", () => {
    expect(() => toAtomicAmount(1, 0)).toThrow(/decimals must be >= 2/);
    expect(() => toAtomicAmount(1, 1)).toThrow(/decimals must be >= 2/);
  });
});
