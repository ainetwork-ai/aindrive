import { verifySiweMessage } from "viem/siwe";
import { basePublicClient } from "./evm";

/**
 * Verify a SIWE (EIP-4361) login signature against the active Base chain.
 *
 * viem's verifySiweMessage delegates signature checking to verifyHash, which
 * resolves EOA (ecrecover), deployed smart wallets (ERC-1271), and
 * counterfactual/undeployed accounts (ERC-6492) through the public client — so
 * Base Account passkey wallets verify without per-type branching. It also
 * re-checks the message's domain / nonce / address against the expected values
 * (defense in depth on top of the route's manual checks + single-use nonce).
 */
export async function verifyWalletSignature(args: {
  message: string;
  signature: string;
  address: string;
  nonce: string;
  domain: string;
}): Promise<boolean> {
  try {
    return await verifySiweMessage(basePublicClient(), {
      message: args.message,
      signature: args.signature as `0x${string}`,
      address: args.address as `0x${string}`,
      nonce: args.nonce,
      domain: args.domain,
    });
  } catch {
    return false;
  }
}
