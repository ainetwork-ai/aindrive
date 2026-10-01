// Read-only chain checks for the x402 support CLI (scripts/x402-settlements.mjs,
// docs/X402_PAYMENT_PENDING.md): did an account's recorded EIP-3009
// authorization move money, and in which transaction? Used ONLY by an operator
// before crediting or releasing a row by hand — no request path imports this,
// and nothing here writes anything.

import { createPublicClient, http, parseAbi, parseEventLogs } from "viem";
import { base, baseSepolia } from "viem/chains";

export const EIP3009_ABI = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/** CAIP-2 network → viem chain + the server's RPC env (lib/evm.ts). */
const NETWORKS = {
  "eip155:8453": { chain: base, rpc: () => process.env.AINDRIVE_BASE_RPC ?? "https://mainnet.base.org" },
  "eip155:84532": { chain: baseSepolia, rpc: () => process.env.AINDRIVE_BASE_SEPOLIA_RPC ?? "https://sepolia.base.org" },
};

/**
 * A read-only client for a row's network. `rpc` overrides the URL (any chain
 * id the RPC serves; for a local test chain pass both).
 * @param {string} network CAIP-2
 * @param {string} [rpc]
 */
export function clientForNetwork(network, rpc) {
  const n = NETWORKS[/** @type {keyof typeof NETWORKS} */ (network)];
  if (!n && !rpc) throw new Error(`no RPC known for ${network}; pass --rpc`);
  const id = Number(network.split(":")[1]);
  const chain = n?.chain ?? { id, name: network, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
  return createPublicClient({ chain, transport: http(rpc ?? n.rpc(), { timeout: 15_000, retryCount: 1 }) });
}

/**
 * The token's own answer: has (payer, nonce) been used (or cancelled)?
 * @param {any} client
 * @param {{ asset: string; payer: string; nonce: string }} row
 * @returns {Promise<boolean>}
 */
export async function authorizationUsed(client, row) {
  return client.readContract({ address: row.asset, abi: EIP3009_ABI, functionName: "authorizationState", args: [row.payer, row.nonce] });
}

/**
 * Transactions in [fromBlock, toBlock] that used (payer, nonce): the token's
 * AuthorizationUsed logs, read in chunks (public RPCs cap the range).
 * @param {any} client
 * @param {{ asset: string; payer: string; nonce: string }} row
 * @param {{ fromBlock: bigint; toBlock: bigint; chunk?: bigint }} range
 * @returns {Promise<{ txHash: string; blockNumber: bigint; logIndex: number }[]>}
 */
export async function findAuthorizationUses(client, row, range) {
  const chunk = range.chunk ?? 10_000n;
  const event = EIP3009_ABI.find((x) => x.type === "event" && x.name === "AuthorizationUsed");
  /** @type {{ txHash: string; blockNumber: bigint; logIndex: number }[]} */
  const out = [];
  for (let from = range.fromBlock; from <= range.toBlock; from += chunk) {
    const to = from + chunk - 1n < range.toBlock ? from + chunk - 1n : range.toBlock;
    const logs = await client.getLogs({ address: row.asset, event, args: { authorizer: row.payer, nonce: row.nonce }, fromBlock: from, toBlock: to });
    for (const l of logs) out.push({ txHash: l.transactionHash, blockNumber: l.blockNumber, logIndex: l.logIndex });
  }
  return out;
}

/**
 * Whether `txHash` is this row's payment: a successful transaction of the
 * row's token that emitted AuthorizationUsed(payer, nonce) AND a Transfer of
 * exactly the recorded amount from the payer to the sale's payee.
 * @param {any} client
 * @param {{ asset: string; payer: string; nonce: string; pay_to: string; amount_atomic: string }} row
 * @param {string} txHash
 * @returns {Promise<{ ok: true; blockNumber: bigint; confirmations: bigint } | { ok: false; reason: string }>}
 */
export async function checkPaymentTx(client, row, txHash) {
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch (e) {
    return { ok: false, reason: `no receipt for ${txHash}: ${(/** @type {Error} */ (e)).message.split("\n")[0]}` };
  }
  if (receipt.status !== "success") return { ok: false, reason: `transaction ${txHash} reverted` };
  const asset = row.asset.toLowerCase();
  const logs = parseEventLogs({ abi: EIP3009_ABI, logs: receipt.logs.filter((/** @type {any} */ l) => l.address.toLowerCase() === asset) });
  const used = logs.some((/** @type {any} */ l) => l.eventName === "AuthorizationUsed"
    && l.args.authorizer.toLowerCase() === row.payer.toLowerCase() && l.args.nonce.toLowerCase() === row.nonce.toLowerCase());
  if (!used) return { ok: false, reason: "the transaction did not use this authorization (no AuthorizationUsed(payer, nonce) from the token)" };
  const paid = logs.some((/** @type {any} */ l) => l.eventName === "Transfer"
    && l.args.from.toLowerCase() === row.payer.toLowerCase() && l.args.to.toLowerCase() === row.pay_to.toLowerCase()
    && l.args.value === BigInt(row.amount_atomic));
  if (!paid) return { ok: false, reason: `the transaction has no Transfer of ${row.amount_atomic} from the payer to ${row.pay_to}` };
  const head = await client.getBlockNumber();
  return { ok: true, blockNumber: receipt.blockNumber, confirmations: head - receipt.blockNumber + 1n };
}

/**
 * When a block was mined (unix seconds) — for the operator's question "was
 * this transaction mined before the row was recorded?".
 * @param {any} client
 * @param {bigint} blockNumber
 * @returns {Promise<bigint>}
 */
export async function blockTime(client, blockNumber) {
  const b = await client.getBlock({ blockNumber });
  return b.timestamp;
}
