import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { SiweMessage } from "siwe";

vi.stubEnv("NEXT_PUBLIC_AINDRIVE_PAYMENT_NETWORK", "testnet");
afterEach(() => vi.unstubAllEnvs());

const { verifyWalletSignature } = await import("../siwe-verify.js");

const DOMAIN = "drive.example.test";
const NONCE = "abcd1234efgh";
// Deterministic test EOA (well-known throwaway key; never used for value).
const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

async function buildSigned(over: Partial<{ domain: string; nonce: string }> = {}) {
  const message = new SiweMessage({
    domain: over.domain ?? DOMAIN,
    address: account.address,
    statement: "aindrive wants you to sign in with your wallet.",
    uri: `https://${DOMAIN}`,
    version: "1",
    chainId: 84532,
    nonce: over.nonce ?? NONCE,
  }).prepareMessage();
  const signature = await account.signMessage({ message });
  return { message, signature };
}

describe("verifyWalletSignature (EOA path)", () => {
  it("accepts a valid EOA SIWE signature for the expected domain+nonce", async () => {
    const { message, signature } = await buildSigned();
    const ok = await verifyWalletSignature({
      message, signature, address: account.address, nonce: NONCE, domain: DOMAIN,
    });
    expect(ok).toBe(true);
  });

  it("rejects a signature whose domain does not match the expected domain", async () => {
    const { message, signature } = await buildSigned({ domain: "evil.example" });
    const ok = await verifyWalletSignature({
      message, signature, address: account.address, nonce: NONCE, domain: DOMAIN,
    });
    expect(ok).toBe(false);
  });

  it("rejects when the expected nonce differs from the message nonce", async () => {
    const { message, signature } = await buildSigned();
    const ok = await verifyWalletSignature({
      message, signature, address: account.address, nonce: "wrongnonce99", domain: DOMAIN,
    });
    expect(ok).toBe(false);
  });

  it("rejects a tampered signature", async () => {
    const { message } = await buildSigned();
    const ok = await verifyWalletSignature({
      message, signature: "0xdeadbeef", address: account.address, nonce: NONCE, domain: DOMAIN,
    });
    expect(ok).toBe(false);
  });
});
