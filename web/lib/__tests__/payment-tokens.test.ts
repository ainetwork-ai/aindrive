import { describe, it, expect } from "vitest";
import {
  DEFAULT_TOKENS,
  TOKEN_PRESETS,
  resolveDriveTokens,
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
});
