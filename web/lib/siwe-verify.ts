import { parseSiweMessage, verifySiweMessage } from "viem/siwe";
import { basePublicClient } from "./evm";

export type SiweLoginFields = { address: string; nonce: string; chainId: number };

/**
 * Extract the SIWE fields the wallet routes pre-check, using the SAME parser
 * the signature verifier uses (viem). The routes previously parsed with
 * spruceid `siwe`, which is stricter than the verifier — e.g. it throws on a
 * non-EIP-55 (lowercase) address, which Base App's native signInWithEthereum
 * builder emits — so messages that verify fine were rejected up front
 * ("bad message" 400s, 2026-07 report). One parser for pre-check and verify
 * means they can never disagree about what a message says.
 */
export function parseSiweLoginFields(message: string): SiweLoginFields | null {
  const parsed = parseSiweMessage(message);
  if (!parsed.address || !parsed.nonce || parsed.chainId === undefined) return null;
  return { address: parsed.address, nonce: parsed.nonce, chainId: parsed.chainId };
}

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
  } catch (e) {
    // Deliberately still `false` (→ 401), but never silently: an RPC outage
    // and a forged signature must at least be distinguishable in the logs.
    console.error("[siwe-verify] verifySiweMessage threw:", e);
    return false;
  }
}
