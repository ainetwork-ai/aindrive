// Sponsored-gas core for permit2 purchases (server-side).
//
// Problem: a permit2 token (e.g. FANCO) needs an on-chain approve(Permit2)
// before the gasless x402 pay signature can settle — the ONLY step in the
// whole purchase where the buyer must own ETH. For smart-wallet buyers
// (Base Account passkey) we sponsor that approve through an ERC-7677
// paymaster (CDP Paymaster): the wallet asks OUR proxy (app/api/paymaster)
// for paymaster data, and the proxy forwards to AINDRIVE_PAYMASTER_URL only
// after validating that the user operation is EXACTLY the approve we agreed
// to sponsor. That agreement is a short-lived signed *sponsor grant* minted
// to the logged-in buyer (app/api/paymaster/grant).
//
// Defense layers against paymaster-budget draining:
//   1. grant: session-authenticated mint, rate-limited, wallet+asset+amount+
//      chain-bound, 10-min TTL, HMAC-signed (lib/sig.js, flat payload).
//   2. proxy: decodes the smart wallet's callData and rejects anything that
//      is not a single zero-value approve(PERMIT2, grant.amount) on
//      grant.asset from grant.wallet.
//   3. CDP portal policy (contract allowlist + spend caps) — operator-side
//      backstop, configured outside this repo (docs/DEPLOY.md).
import { decodeFunctionData } from "viem";
import { signPayload, verifyPayload } from "./sig.js";
import { env } from "./env";

// Canonical Uniswap Permit2 — same address on every EVM chain. (Mirrors
// @x402/evm's PERMIT2_ADDRESS, not re-exported from the client entrypoint;
// components/share-gate.tsx carries the same mirror for the client bundle.)
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

export const SPONSOR_GRANT_TTL_MS = 10 * 60 * 1000;

export function paymasterEnabled(): boolean {
  return !!process.env.AINDRIVE_PAYMASTER_URL;
}

// Flat payload (lib/sig.js canonicalisation does not recurse — keep it flat).
export type SponsorGrant = {
  v: 1;
  wallet: string;  // buyer's smart-wallet address (lowercase)
  asset: string;   // ERC-20 being approved (lowercase)
  chainId: number; // numeric chain id the approve must run on
  amount: string;  // atomic units the approve must be for (exact match)
  exp: number;     // epoch ms
};

/** Mint a signed sponsor grant. Wire format: base64url(JSON payload) + "." + sig. */
export function mintSponsorGrant(fields: {
  wallet: string; asset: string; chainId: number; amount: string;
}): string {
  const payload: SponsorGrant = {
    v: 1,
    wallet: fields.wallet.toLowerCase(),
    asset: fields.asset.toLowerCase(),
    chainId: fields.chainId,
    amount: fields.amount,
    exp: Date.now() + SPONSOR_GRANT_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${signPayload(env.sessionSecret, payload)}`;
}

/** Verify signature + expiry. Returns the payload or null. */
export function verifySponsorGrant(grant: string): SponsorGrant | null {
  const dot = grant.lastIndexOf(".");
  if (dot <= 0) return null;
  let payload: SponsorGrant;
  try {
    payload = JSON.parse(Buffer.from(grant.slice(0, dot), "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload?.v !== 1 || typeof payload.exp !== "number") return null;
  if (!verifyPayload(env.sessionSecret, payload, grant.slice(dot + 1))) return null;
  if (Date.now() > payload.exp) return null;
  return payload;
}

// Coinbase Smart Wallet (Base Account) execution wrappers: a sponsored userOp's
// callData is the account contract calling one of these, not the ERC-20
// directly. Both are validated down to the inner approve.
const SMART_WALLET_EXECUTE_ABI = [
  {
    type: "function", name: "execute", stateMutability: "payable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function", name: "executeBatch", stateMutability: "payable",
    inputs: [{
      name: "calls", type: "tuple[]",
      components: [
        { name: "target", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
      ],
    }],
    outputs: [],
  },
] as const;

const ERC20_APPROVE_ABI = [{
  type: "function", name: "approve", stateMutability: "nonpayable",
  inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ type: "bool" }],
}] as const;

export type SponsorValidation = { ok: true } | { ok: false; reason: string };

/**
 * The proxy's gate: a user operation is sponsored ONLY if it is the buyer's
 * own wallet making a single zero-value approve(PERMIT2, grant.amount) on
 * grant.asset. Anything else — other targets, other spenders, other amounts,
 * batched extras, value transfers — is refused before it reaches the
 * paymaster, so a leaked/valid grant cannot buy arbitrary sponsored gas.
 */
export function validateSponsoredUserOp(args: {
  grant: SponsorGrant;
  sender: string;
  callData: string;
}): SponsorValidation {
  const { grant, sender, callData } = args;
  if (typeof sender !== "string" || sender.toLowerCase() !== grant.wallet) {
    return { ok: false, reason: "sender is not the granted wallet" };
  }
  if (typeof callData !== "string" || !callData.startsWith("0x")) {
    return { ok: false, reason: "malformed callData" };
  }
  let calls: Array<{ target: string; value: bigint; data: string }>;
  try {
    const decoded = decodeFunctionData({
      abi: SMART_WALLET_EXECUTE_ABI,
      data: callData as `0x${string}`,
    });
    if (decoded.functionName === "execute") {
      const [target, value, data] = decoded.args;
      calls = [{ target, value, data }];
    } else {
      calls = decoded.args[0].map((c) => ({ target: c.target, value: c.value, data: c.data }));
    }
  } catch {
    return { ok: false, reason: "callData is not a smart-wallet execute" };
  }
  if (calls.length !== 1) {
    return { ok: false, reason: "exactly one call may be sponsored" };
  }
  const call = calls[0];
  if (call.target.toLowerCase() !== grant.asset) {
    return { ok: false, reason: "call target is not the granted asset" };
  }
  if (call.value !== 0n) {
    return { ok: false, reason: "sponsored call must not transfer value" };
  }
  let spender: string;
  let amount: bigint;
  try {
    const inner = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: call.data as `0x${string}` });
    [spender, amount] = inner.args;
  } catch {
    return { ok: false, reason: "inner call is not approve()" };
  }
  if (spender.toLowerCase() !== PERMIT2_ADDRESS.toLowerCase()) {
    return { ok: false, reason: "approve spender is not Permit2" };
  }
  if (amount !== BigInt(grant.amount)) {
    return { ok: false, reason: "approve amount does not match the grant" };
  }
  return { ok: true };
}
