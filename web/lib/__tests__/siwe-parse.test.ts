import { describe, it, expect } from "vitest";
import { parseSiweLoginFields } from "../siwe-verify";

// Regression for the 2026-07 "bad message" 400s: the login/verify routes must
// accept every message the signature verifier (viem) accepts. The old spruceid
// parser threw on a non-EIP-55 (lowercase) address — the shape Base App's
// native signInWithEthereum builder emits — rejecting logins that would have
// verified fine.

const CHECKSUMMED = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";

function siweMessage(address: string): string {
  return `aindrive.ainetwork.ai wants you to sign in with your Ethereum account:
${address}

Sign in to aindrive

URI: https://aindrive.ainetwork.ai
Version: 1
Chain ID: 8453
Nonce: abcdef12345678
Issued At: 2026-07-21T00:00:00.000Z`;
}

describe("parseSiweLoginFields", () => {
  it("extracts address/nonce/chainId from a canonical message", () => {
    expect(parseSiweLoginFields(siweMessage(CHECKSUMMED))).toEqual({
      address: CHECKSUMMED,
      nonce: "abcdef12345678",
      chainId: 8453,
    });
  });

  it("accepts a lowercase (non-EIP-55) address — the Base App message shape", () => {
    const fields = parseSiweLoginFields(siweMessage(CHECKSUMMED.toLowerCase()));
    expect(fields?.address.toLowerCase()).toBe(CHECKSUMMED.toLowerCase());
    expect(fields?.nonce).toBe("abcdef12345678");
    expect(fields?.chainId).toBe(8453);
  });

  it("returns null for non-SIWE input (garbage, hex blob)", () => {
    expect(parseSiweLoginFields("not a siwe message at all, but long enough")).toBeNull();
    expect(parseSiweLoginFields("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).toBeNull();
  });
});
