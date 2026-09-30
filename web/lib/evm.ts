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

// CAIP-2 network (x402 wire form) → a read-only client for that chain, or
// null for a chain this server has no RPC for. Unlike basePublicClient() this
// is not pinned to the active chain: a testnet deployment may quote custom
// tokens on Base mainnet (payment-tokens.ts policyChainViolation), and a
// settle on that chain must be checkable on that chain.
const CHAIN_BY_CAIP2: Record<string, keyof typeof CHAINS> = {
  "eip155:8453": "base",
  "eip155:84532": "base-sepolia",
};
export function publicClientForNetwork(network: string): PublicClient | null {
  const name = CHAIN_BY_CAIP2[network];
  if (!name) return null;
  const { chain, rpc } = CHAINS[name];
  return createPublicClient({ chain: chain as Chain, transport: http(rpc) });
}
