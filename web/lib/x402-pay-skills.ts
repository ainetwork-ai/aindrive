/**
 * The pay skills — aindrive as an x402 *client and facilitator front* for an
 * account, over MCP / A2A, so an app acting as the account (ainmem's
 * pocket-money gift, an agent buying a file) can pay without holding a key:
 *
 *   x402_wallet  {}                                        → { address }
 *   x402_sign    { x402Version, paymentRequirements,
 *                  resource? }                             → { paymentPayload }
 *   x402_settle  { paymentPayload, paymentRequirements }   → { success, transaction,
 *                                                             network, payer, errorReason? }
 *
 * Shapes are x402 v2's (`PaymentPayload`, `PaymentRequirements`, the
 * facilitator's /settle reply), so a caller can drop these in where it would
 * call a facilitator. Signing is EIP-3009 (the "exact" scheme's eip3009
 * transfer method) with the account's agent wallet (lib/agent-wallets.ts);
 * permit2 tokens need an on-chain approve first and are refused here.
 * Settlement goes through the server's facilitator (lib/x402-facilitator.ts)
 * — the same one paid shares settle with, dev bypass included.
 *
 * Offered only with AINDRIVE_AGENT_WALLETS=1 (see agent-wallets.ts) and, on
 * account grants, the `wallet:pay` scope.
 */
import { randomBytes } from "node:crypto";
import { getAddress, isAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { SkillResult } from "@/shared/agent-skills";
import { agentWalletOf, agentWalletsEnabled } from "./agent-wallets";
import { canSettle, verifyAndSettle } from "./x402-facilitator";

export type PaySkillName = "x402_wallet" | "x402_sign" | "x402_settle";

const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const err = (code: "invalid_params" | "forbidden" | "internal", message: string): SkillResult => ({ kind: "err", code, message });

function requirementsOf(v: unknown): PaymentRequirements | null {
  const r = v as PaymentRequirements | undefined;
  if (!r || typeof r !== "object") return null;
  if (r.scheme !== "exact" || typeof r.network !== "string" || typeof r.asset !== "string" || typeof r.payTo !== "string" || typeof r.amount !== "string") return null;
  return r;
}

function chainIdOf(network: string): number | null {
  const m = /^eip155:(\d+)$/.exec(network);
  return m ? Number(m[1]) : null;
}

export async function runPaySkill(userId: string, name: PaySkillName, args: Record<string, unknown>): Promise<SkillResult> {
  if (!agentWalletsEnabled()) return err("forbidden", "agent wallets are off on this server (AINDRIVE_AGENT_WALLETS)");

  switch (name) {
    case "x402_wallet": {
      const { address } = agentWalletOf(userId);
      return { kind: "ok", structured: { address, kind: "agent" }, text: address };
    }

    case "x402_sign": {
      const req = requirementsOf(args.paymentRequirements);
      if (!req) return err("invalid_params", "paymentRequirements (x402 v2, scheme exact) required");
      const extra = (req.extra ?? {}) as { name?: string; version?: string; assetTransferMethod?: string };
      if (extra.assetTransferMethod === "permit2") return err("invalid_params", "permit2 tokens need an on-chain approve; only eip3009 is signed here");
      if (!extra.name || !extra.version) return err("invalid_params", "paymentRequirements.extra.name/version (the token's EIP-712 domain) required");
      const chainId = chainIdOf(req.network);
      if (!chainId) return err("invalid_params", `unsupported network ${req.network} (eip155:<id> expected)`);
      if (!isAddress(req.asset) || !isAddress(req.payTo)) return err("invalid_params", "asset and payTo must be addresses");
      let value: bigint;
      try {
        value = BigInt(req.amount);
      } catch {
        return err("invalid_params", "amount must be an atomic integer string");
      }
      const wallet = agentWalletOf(userId);
      const account = privateKeyToAccount(wallet.key);
      const now = Math.floor(Date.now() / 1000);
      const authorization = {
        from: account.address,
        to: getAddress(req.payTo),
        value: value.toString(),
        validAfter: String(now - 60),
        validBefore: String(now + (typeof req.maxTimeoutSeconds === "number" ? req.maxTimeoutSeconds : 300)),
        nonce: `0x${randomBytes(32).toString("hex")}` as Hex,
      };
      const signature = await account.signTypedData({
        domain: { name: extra.name, version: extra.version, chainId, verifyingContract: getAddress(req.asset) },
        types: AUTH_TYPES,
        primaryType: "TransferWithAuthorization",
        message: { ...authorization, value, validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
      });
      const resource = args.resource && typeof args.resource === "object" ? args.resource : undefined;
      const paymentPayload = { x402Version: 2, ...(resource ? { resource } : {}), accepted: req, payload: { signature, authorization } };
      return { kind: "ok", structured: { paymentPayload }, text: `signed ${req.amount} → ${req.payTo} on ${req.network}` };
    }

    case "x402_settle": {
      const req = requirementsOf(args.paymentRequirements);
      const payload = args.paymentPayload as PaymentPayload | undefined;
      if (!req || !payload || typeof payload !== "object" || !payload.payload) return err("invalid_params", "paymentPayload and paymentRequirements required");
      if (!canSettle()) return err("internal", "payments are not configured on this server");
      const r = await verifyAndSettle(payload, req, "x402_settle");
      if (!r.ok) {
        return { kind: "ok", structured: { success: false, errorReason: r.reason, status: r.status, network: req.network }, text: `not settled: ${r.reason}` };
      }
      return {
        kind: "ok",
        structured: { success: true, transaction: r.transaction, network: r.network, payer: r.payer, bypass: r.bypass },
        text: `settled ${r.transaction} on ${r.network}`,
      };
    }
  }
}
