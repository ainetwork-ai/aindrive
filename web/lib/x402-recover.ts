/**
 * Recovery for an EIP-3009 payment that settled on-chain while this server
 * never saw the facilitator's success answer.
 *
 * The case: the facilitator mines `transferWithAuthorization`, then its HTTP
 * response is lost (connection reset, proxy timeout, facilitator restart).
 * verifyAndSettle retries settle once, and every later attempt — the same
 * envelope retried by the buyer's product — is refused by the facilitator
 * because the authorization nonce is now used. Without this check the buyer
 * is charged and holds nothing ("paid, access not granted").
 *
 * The chain is the authority, so we ask it: the authorization is consumed
 * (`authorizationState`), an `AuthorizationUsed(from, nonce)` log exists, and
 * the SAME successful transaction moved exactly `amount` of the asset from the
 * payer to this sale's `payTo`. Only then is the payment treated as settled,
 * with that transaction hash. Anything else (not used, cancelled via
 * cancelAuthorization, different recipient/amount, reverted, RPC error, older
 * than the look-back window) returns null and the caller keeps its 402.
 *
 * EIP-3009 only: a permit2 settle has no per-authorization event to look up.
 * The caller must still refuse a transaction that already has a receipt, so
 * one payment is never credited twice (app/api/s/[token]/route.ts).
 */
import { decodeEventLog, isAddressEqual, parseAbi, parseAbiItem, type PublicClient } from "viem";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { publicClientForNetwork } from "./evm";

const AUTH_STATE_ABI = parseAbi(["function authorizationState(address authorizer, bytes32 nonce) view returns (bool)"]);
const AUTHORIZATION_USED = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/** How far back (blocks) to look for the AuthorizationUsed log. Default ≈ 5.5 h on Base (2 s blocks). */
export function recoveryLookbackBlocks(): bigint {
  const n = Number(process.env.AINDRIVE_X402_RECOVERY_LOOKBACK_BLOCKS ?? 10_000);
  return BigInt(Number.isInteger(n) && n > 0 ? n : 10_000);
}

type Hex = `0x${string}`;
type Authorization = { from?: string; to?: string; value?: string | number; nonce?: string };
export type RecoveredSettlement = { payer: string; transaction: string; network: string };
/** The slice of a viem PublicClient this module reads with (tests pass a fake). */
export type RecoveryClient = Pick<PublicClient, "readContract" | "getBlockNumber" | "getLogs" | "getTransactionReceipt">;

const isHex = (v: unknown, bytes?: number): v is Hex =>
  typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v) && (bytes === undefined || v.length === 2 + bytes * 2);

export async function recoverSettledAuthorization(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  client: RecoveryClient | null = publicClientForNetwork(requirements.network),
): Promise<RecoveredSettlement | null> {
  const auth = (payload?.payload as { authorization?: Authorization } | undefined)?.authorization;
  if (!client || !auth) return null;
  if (requirements.scheme !== "exact" || (requirements.extra as { assetTransferMethod?: string } | undefined)?.assetTransferMethod === "permit2") return null;
  const { from, to, nonce } = auth;
  const asset = requirements.asset;
  if (!isHex(from, 20) || !isHex(to, 20) || !isHex(nonce, 32) || !isHex(asset, 20) || !isHex(requirements.payTo, 20)) return null;
  let amount: bigint;
  try {
    amount = BigInt(requirements.amount);
    if (BigInt(auth.value ?? -1) !== amount) return null; // an envelope for a different price
  } catch {
    return null;
  }
  if (!isAddressEqual(to, requirements.payTo as Hex)) return null; // an envelope for a different seller

  try {
    const used = await client.readContract({ address: asset, abi: AUTH_STATE_ABI, functionName: "authorizationState", args: [from, nonce] });
    if (used !== true) return null;
    const latest = await client.getBlockNumber();
    const lookback = recoveryLookbackBlocks();
    const fromBlock = latest > lookback ? latest - lookback : 0n;
    const logs = await client.getLogs({ address: asset, event: AUTHORIZATION_USED, args: { authorizer: from, nonce }, fromBlock, toBlock: latest });
    for (const log of logs) {
      if (!log.transactionHash) continue;
      const receipt = await client.getTransactionReceipt({ hash: log.transactionHash });
      if (receipt.status !== "success") continue;
      const paid = receipt.logs.some((l) => {
        if (!isAddressEqual(l.address, asset)) return false;
        try {
          const ev = decodeEventLog({ abi: [TRANSFER], data: l.data, topics: l.topics });
          return isAddressEqual(ev.args.from, from) && isAddressEqual(ev.args.to, to) && ev.args.value === amount;
        } catch {
          return false;
        }
      });
      if (paid) return { payer: from.toLowerCase(), transaction: log.transactionHash, network: requirements.network };
    }
    return null;
  } catch (e) {
    console.warn(`[x402-recover] chain lookup failed net=${requirements.network}: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
    return null;
  }
}
