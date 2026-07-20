import { describe, it, expect } from "vitest";
import { walletConnectSiweRequest, extractSiweAuth } from "../base-siwe";

describe("walletConnectSiweRequest", () => {
  it("builds a wallet_connect request with the SIWE capability (hex chainId)", () => {
    expect(walletConnectSiweRequest("abc123", 8453)).toEqual({
      method: "wallet_connect",
      params: [
        {
          version: "1",
          capabilities: {
            signInWithEthereum: { nonce: "abc123", chainId: "0x2105" },
          },
        },
      ],
    });
  });

  it("hex-encodes the Base Sepolia chain id", () => {
    const req = walletConnectSiweRequest("n", 84532);
    expect(req.params[0].capabilities.signInWithEthereum.chainId).toBe("0x14a34");
  });
});

describe("extractSiweAuth", () => {
  const valid = {
    accounts: [
      {
        address: "0x74f1b6289a00df3b7c76186b9B90c7C67BEBd5f2",
        capabilities: {
          signInWithEthereum: { message: "msg", signature: "0xsig" },
        },
      },
    ],
  };

  it("extracts address/message/signature from a wallet_connect response", () => {
    expect(extractSiweAuth(valid)).toEqual({
      address: "0x74f1b6289a00df3b7c76186b9B90c7C67BEBd5f2",
      message: "msg",
      signature: "0xsig",
    });
  });

  it("throws when the response has no accounts", () => {
    expect(() => extractSiweAuth({ accounts: [] })).toThrow(/signInWithEthereum/);
    expect(() => extractSiweAuth(undefined)).toThrow(/signInWithEthereum/);
  });

  it("throws when the SIWE capability result is missing", () => {
    const noSiwe = { accounts: [{ address: "0xabc", capabilities: {} }] };
    expect(() => extractSiweAuth(noSiwe)).toThrow(/signInWithEthereum/);
  });
});
