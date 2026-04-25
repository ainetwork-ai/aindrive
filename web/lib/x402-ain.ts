/**
 * x402 v2 AIN facilitator for Ethereum mainnet.
 *
 * AIN token: 0x3A810ff7211b40c4fA76205a14efe161615d0385 (decimals=12)
 * AIN does NOT support EIP-3009 or EIP-2612 — client broadcasts a normal
 * ERC-20 transfer and submits the txHash for on-chain verification.
 */

import { createPublicClient, http, parseAbiItem, decodeEventLog, type Log } from "viem";
import { mainnet } from "viem/chains";
import { txHashUsed } from "./paid-lifts.js";

// ─── Wire types ──────────────────────────────────────────────────────────────

export interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  amount: string;     // atomic units (string to avoid JS bigint json issues)
  decimals: number;
  description: string;
  resource: string;
  extra?: Record<string, unknown>;
}

export interface PaymentPayload {
  x402Version: number;
  accepted: PaymentRequirements;
  payload: {
    transaction: string;  // 0x<txHash>
    from: string;         // 0x<signer>
  };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const AIN_TOKEN = "0x3A810ff7211b40c4fA76205a14efe161615d0385" as const;
const PAY_TO    = "0x8d31FC509ef87453500C3bca73b8a0916d66d0de" as const;
const NETWORK   = "eip155:1" as const;
const DECIMALS  = 12 as const;

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

// ─── Client (singleton per process) ─────────────────────────────────────────

function getClient() {
  const rpc = process.env.AINDRIVE_ETH_RPC ?? "https://eth.llamarpc.com";
  return createPublicClient({ chain: mainnet, transport: http(rpc) });
}

// ─── Builders ────────────────────────────────────────────────────────────────

export function buildPaymentRequirements({
  scope,
  priceAinUnits,
  resource,
  description,
}: {
  scope: string;
  priceAinUnits: string;
  resource: string;
  description?: string;
}): PaymentRequirements {
  return {
    scheme: "ain-erc20-transfer",
    network: NETWORK,
    asset: AIN_TOKEN,
    payTo: PAY_TO,
    amount: priceAinUnits,
    decimals: DECIMALS,
    description: description ?? `Pay ${priceAinUnits} AIN (base units) to lift quota: ${scope}`,
    resource,
    extra: { scope },
  };
}

export function build402Body({
  requirements,
  resource,
  error,
}: {
  requirements: PaymentRequirements;
  resource: { url: string; description?: string; mimeType?: string };
  error: string;
}) {
  return {
    x402Version: 2,
    error,
    resource: {
      url: resource.url,
      description: resource.description ?? "AIN payment required",
      mimeType: resource.mimeType ?? "application/json",
    },
    accepts: [requirements],
    extensions: {},
  };
}

// ─── Header helpers ──────────────────────────────────────────────────────────

export function parsePaymentSignature(headerValue: string | null): PaymentPayload | null {
  if (!headerValue) return null;
  try {
    const json = Buffer.from(headerValue, "base64").toString("utf8");
    return JSON.parse(json) as PaymentPayload;
  } catch {
    return null;
  }
}

export function encodePaymentResponse({
  transaction,
  settledAt,
}: {
  transaction: string;
  settledAt: number;
}): string {
  return Buffer.from(JSON.stringify({ transaction, settledAt })).toString("base64");
}

// ─── Verify ──────────────────────────────────────────────────────────────────

export async function verify(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  opts?: { maxAgeSeconds?: number }
): Promise<{ ok: true; payer: string; txHash: string } | { ok: false; error: string }> {
  const txHash = payload.payload.transaction as `0x${string}`;
  const fromAddr = payload.payload.from.toLowerCase();

  // Anti-replay check first (cheap, no network call)
  if (await txHashUsed(txHash)) {
    return { ok: false, error: "tx already used" };
  }

  const client = getClient();

  let receipt: Awaited<ReturnType<typeof client.getTransactionReceipt>>;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch {
    return { ok: false, error: "tx not found" };
  }

  if (receipt.status !== "success") {
    return { ok: false, error: "tx reverted" };
  }

  // Require at least 1 confirmation
  let currentBlock: bigint;
  try {
    currentBlock = await client.getBlockNumber();
  } catch {
    return { ok: false, error: "could not fetch block number" };
  }

  if (receipt.blockNumber == null || currentBlock < receipt.blockNumber + 1n) {
    return { ok: false, error: "tx not yet confirmed" };
  }

  // Staleness guard
  const maxAge = opts?.maxAgeSeconds ?? 86400;
  if (maxAge > 0) {
    let block: Awaited<ReturnType<typeof client.getBlock>>;
    try {
      block = await client.getBlock({ blockNumber: receipt.blockNumber });
    } catch {
      return { ok: false, error: "could not fetch block timestamp" };
    }
    const txAgeSeconds = Math.floor(Date.now() / 1000) - Number(block.timestamp);
    if (txAgeSeconds > maxAge) {
      return { ok: false, error: "tx too old" };
    }
  }

  // Find Transfer log from AIN contract
  const assetAddr = requirements.asset.toLowerCase();
  const transferLog = receipt.logs.find(
    (log: Log) =>
      log.address.toLowerCase() === assetAddr &&
      log.topics.length === 3 &&
      // Transfer(from, to, value) has topic[0] = keccak256("Transfer(address,address,uint256)")
      log.topics[0]?.toLowerCase() ===
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
  );

  if (!transferLog) {
    return { ok: false, error: "no Transfer log from AIN contract" };
  }

  // Decode the log
  let decoded: { args: { from: string; to: string; value: bigint } };
  try {
    decoded = decodeEventLog({
      abi: [TRANSFER_EVENT],
      data: transferLog.data,
      topics: transferLog.topics as [`0x${string}`, ...`0x${string}`[]],
    }) as { args: { from: string; to: string; value: bigint } };
  } catch {
    return { ok: false, error: "could not decode Transfer log" };
  }

  const { from, to, value } = decoded.args;

  if (to.toLowerCase() !== requirements.payTo.toLowerCase()) {
    return { ok: false, error: "transfer recipient mismatch" };
  }
  if (from.toLowerCase() !== fromAddr) {
    return { ok: false, error: "transfer sender mismatch" };
  }
  if (value < BigInt(requirements.amount)) {
    return { ok: false, error: "transfer amount insufficient" };
  }

  return { ok: true, payer: from.toLowerCase(), txHash };
}

// ─── Settle ──────────────────────────────────────────────────────────────────

export async function settle(
  payload: PaymentPayload,
  requirements: PaymentRequirements
): Promise<
  | { success: true; transaction: string; payer: string }
  | { success: false; errorReason: string }
> {
  const result = await verify(payload, requirements);
  if (!result.ok) {
    return { success: false, errorReason: result.error };
  }
  return {
    success: true,
    transaction: payload.payload.transaction,
    payer: result.payer,
  };
}
