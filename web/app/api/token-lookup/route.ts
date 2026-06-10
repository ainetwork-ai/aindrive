// On-chain token lookup for the drive's payment-token policy editor. An owner
// pastes a contract address; this reads the token's metadata from chain so the
// UI can (a) auto-fill symbol/decimals/name, and (b) decide the token's x402
// transferMethod: eip3009 when the entrypoint + full EIP-712 domain exist,
// else the universal permit2 path (any ERC-20 settles).
//
// IMPORTANT (verified against the x402 exact-evm scheme): eip3009 signing
// reads the token's EIP-712 domain name/version from PaymentRequirements.extra,
// NOT from chain — `version()` is a USDC-ism most tokens won't expose. We
// probe EIP-3009 via authorizationState (the canonical marker), best-effort
// read name()/version(), and let the UI ask the owner to fill version when
// the token doesn't publish it. The dialog finalizes the transferMethod at
// save time (version supplied → eip3009, otherwise permit2).
//
// Server-side on purpose: the RPC endpoint + the "is this really an ERC-20"
// trust check live behind the API, not in the browser. Read-only (staticcall),
// no writes, login-gated to avoid anonymous RPC amplification.
import { NextResponse } from "next/server";
import { z } from "zod";
import { createPublicClient, http, getAddress, type Abi } from "viem";
import { base, baseSepolia } from "viem/chains";
import { getUser } from "@/lib/session";

// chain symbol (matches PaymentToken.chain / TOKEN_PRESETS) → viem chain + RPC.
const CHAINS = {
  base: { chain: base, rpc: process.env.AINDRIVE_BASE_RPC ?? "https://mainnet.base.org" },
  "base-sepolia": { chain: baseSepolia, rpc: process.env.AINDRIVE_BASE_SEPOLIA_RPC ?? "https://sepolia.base.org" },
} as const;

const Body = z.object({
  chain: z.enum(["base", "base-sepolia"]),
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be 0x + 40 hex"),
});

const ERC20_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  // EIP-3009 marker: settleable tokens expose authorizationState(authorizer, nonce).
  {
    type: "function", name: "authorizationState", stateMutability: "view",
    inputs: [{ type: "address" }, { type: "bytes32" }], outputs: [{ type: "bool" }],
  },
] as const satisfies Abi;

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const ZERO32 = `0x${"0".repeat(64)}` as const;

export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid input" }, { status: 400 });
  }
  const { chain, address } = parsed.data;
  const { chain: viemChain, rpc } = CHAINS[chain];
  const client = createPublicClient({ chain: viemChain, transport: http(rpc) });
  const token = getAddress(address);
  const contract = { address: token, abi: ERC20_ABI } as const;

  // symbol + decimals are the minimum to call it an ERC-20. If both fail, the
  // address isn't a token we can price in (or wrong chain).
  let symbol: string, decimals: number;
  try {
    [symbol, decimals] = await Promise.all([
      client.readContract({ ...contract, functionName: "symbol" }),
      client.readContract({ ...contract, functionName: "decimals" }),
    ]);
  } catch {
    return NextResponse.json(
      { error: "not an ERC-20 token on this chain (no symbol/decimals)" },
      { status: 422 },
    );
  }

  // name() and version() are the EIP-712 domain fields. name() is common;
  // version() is often absent — null means we couldn't confirm the domain, so
  // the token can't be auto-marked settleable.
  const name = await client.readContract({ ...contract, functionName: "name" }).catch(() => null);
  const version = await client.readContract({ ...contract, functionName: "version" }).catch(() => null);

  // EIP-3009 probe: a token with the entrypoint answers
  // authorizationState(0x0, 0x0) without reverting (returns false for an
  // unused nonce). A revert / missing function means no
  // transferWithAuthorization path → the token settles via permit2 instead.
  const eip3009 = await client
    .readContract({ ...contract, functionName: "authorizationState", args: [ZERO, ZERO32] })
    .then(() => true)
    .catch(() => false);

  // When eip3009 is true but version() is unpublished, supplying the EIP-712
  // version unlocks the eip3009 path (no approval step for buyers) — the UI
  // prompts for it; left blank, the token still settles via permit2.
  const needsVersion = eip3009 && !version;

  return NextResponse.json({
    ok: true,
    token: { symbol, decimals, name, version, chain, asset: token },
    eip3009,
    needsVersion,
  });
}
