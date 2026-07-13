import { createPublicClient, http, type Chain, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";
import { activeChain } from "./payment-tokens";

// Server-side read-only client for the deployment's active Base chain. Mirrors
// the inline client in app/api/token-lookup/route.ts (kept separate; auth must
// not depend on the token-policy editor). RPC URL falls back to the public
// Base endpoint when the env override is unset.
const CHAINS = {
  base: { chain: base, rpc: process.env.AINDRIVE_BASE_RPC ?? "https://mainnet.base.org" },
  "base-sepolia": { chain: baseSepolia, rpc: process.env.AINDRIVE_BASE_SEPOLIA_RPC ?? "https://sepolia.base.org" },
} as const;

export function basePublicClient(): PublicClient {
  const { chain, rpc } = CHAINS[activeChain()];
  // Widen `chain` to the generic `Chain` type before calling createPublicClient:
  // `base`/`baseSepolia`'s literal OP-stack chain types carry extra formatter
  // variants (e.g. deposit transactions) that make the concrete union
  // `typeof base | typeof baseSepolia` structurally incompatible with the
  // bare `PublicClient` return type this function promises callers.
  return createPublicClient({ chain: chain as Chain, transport: http(rpc) });
}
