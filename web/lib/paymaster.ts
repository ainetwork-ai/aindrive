// Sponsored-gas core for permit2 purchases (server-side).
//
// Problem: a permit2 token (e.g. FANCO) needs an on-chain approve(Permit2)
// before the gasless x402 pay signature can settle — the ONLY step in the
// whole purchase where the buyer must own ETH. For smart-wallet buyers
// (Base Account passkey) we sponsor that approve through an ERC-7677
// paymaster (CDP): the wallet asks OUR proxy (app/api/paymaster) for
// paymaster data, and the proxy forwards to CDP_PAYMASTER_URL only after
// validating the user operation. The paymaster URL never reaches the client.
//
// A signed sponsor *grant* authorises ONE approve. It is not a blank cheque —
// an adversarial security review showed a "valid grant" must still be bounded
// on three axes the grant alone doesn't constrain:
//   • cost   — per-op gas fields are capped (GAS_CAPS) so a malicious `sender`
//              contract can't burn arbitrary budget under callGasLimit.
//   • count  — grants are one-time (jti PRIMARY KEY in sponsored_ops) and total
//              spend is capped per rolling 24h, globally and per minting user.
//   • intent — the op must be exactly the granted zero-value approve(PERMIT2)
//              on the granted asset/amount from the granted wallet.
// The CDP-portal contract allowlist + spend cap remain the out-of-band backstop
// (docs/DEPLOY.md); this module is the in-app enforcement so we never depend on
// that cap being set correctly.
import { randomBytes } from "node:crypto";
import { decodeFunctionData } from "viem";
import { db } from "./db";
import { signPayload, verifyPayload } from "./sig.js";
import { env } from "./env";

// Canonical Uniswap Permit2 — same address on every EVM chain. (Mirrors
// @x402/evm's PERMIT2_ADDRESS, not re-exported from the client entrypoint;
// components/share-gate.tsx carries the same mirror for the client bundle.)
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

export const SPONSOR_GRANT_TTL_MS = 10 * 60 * 1000;

// Per-op gas ceilings (ERC-4337 v0.6/v0.7 fields; Base Account is v0.6). Sized
// to cover a fresh-account deploy + approve with headroom, but bound what one
// sponsored op can ever cost. maxFeePerGas is ~50-100× typical Base fees.
const GAS_CAPS: Record<string, bigint> = {
  callGasLimit: 600_000n,
  verificationGasLimit: 800_000n,        // deploy-inclusive (first purchase)
  preVerificationGas: 200_000n,
  paymasterVerificationGasLimit: 300_000n,
  paymasterPostOpGasLimit: 200_000n,
  maxFeePerGas: 5_000_000_000n,          // 5 gwei
  maxPriorityFeePerGas: 5_000_000_000n,  // 5 gwei
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function paymasterEnabled(): boolean {
  return !!process.env.CDP_PAYMASTER_URL;
}
function dailyCap(): number {
  return Number(process.env.AINDRIVE_PAYMASTER_DAILY_CAP || 500);
}
function perUserDailyCap(): number {
  return Number(process.env.AINDRIVE_PAYMASTER_USER_DAILY_CAP || 20);
}

// Flat payload (lib/sig.js canonicalisation does not recurse — keep it flat).
export type SponsorGrant = {
  v: 1;
  jti: string;     // one-time id (consumed in sponsored_ops)
  sub: string;     // minting account id — the per-user budget/rate key
  token: string;   // share token this grant was minted for
  wallet: string;  // buyer's wallet (lowercase); must equal the op sender
  asset: string;   // ERC-20 being approved (lowercase)
  chainId: number; // numeric chain id the approve must run on
  amount: string;  // atomic units the approve must be for (exact match)
  exp: number;     // epoch ms
};

/** Mint a signed sponsor grant. Wire format: base64url(JSON payload) + "." + sig. */
export function mintSponsorGrant(fields: {
  userId: string; token: string; wallet: string; asset: string; chainId: number; amount: string;
}): string {
  const payload: SponsorGrant = {
    v: 1,
    jti: randomBytes(16).toString("hex"),
    sub: fields.userId,
    token: fields.token,
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
  if (typeof payload.jti !== "string" || typeof payload.sub !== "string") return null;
  if (!verifyPayload(env.sessionSecret, payload, grant.slice(dot + 1))) return null;
  if (Date.now() > payload.exp) return null;
  return payload;
}

// Coinbase Smart Wallet (Base Account) execution wrappers: a sponsored userOp's
// callData is the account contract calling one of these, not the ERC-20
// directly. ABI verified field/order-exact against the deployed
// CoinbaseSmartWallet.sol (execute + executeBatch(Call[])).
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

export type UserOpLike = {
  sender?: string;
  callData?: string;
  // v0.6/v0.7 gas fields — hex quantity strings or numbers, may be absent at
  // the stub stage (gas enforced only when enforceGas=true, i.e. getPaymasterData).
  callGasLimit?: string | number;
  verificationGasLimit?: string | number;
  preVerificationGas?: string | number;
  paymasterVerificationGasLimit?: string | number;
  paymasterPostOpGasLimit?: string | number;
  maxFeePerGas?: string | number;
  maxPriorityFeePerGas?: string | number;
};

export type SponsorValidation = { ok: true } | { ok: false; reason: string };

function toBigIntOrNull(v: string | number | undefined): bigint | null {
  if (v === undefined || v === null) return null;
  try { return BigInt(v); } catch { return null; }
}

/**
 * The proxy's gate. A user operation is sponsorable ONLY if it is the buyer's
 * own wallet making a single zero-value approve(PERMIT2, grant.amount) on
 * grant.asset — AND (when enforceGas) every present gas field is within
 * GAS_CAPS, so cost is bounded even if `sender` is a hostile contract.
 */
export function validateSponsoredApprove(args: {
  grant: SponsorGrant;
  op: UserOpLike;
  enforceGas: boolean;
}): SponsorValidation {
  const { grant, op, enforceGas } = args;
  const sender = op.sender;
  const callData = op.callData;
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
  if (enforceGas) {
    for (const [field, cap] of Object.entries(GAS_CAPS)) {
      const v = toBigIntOrNull(op[field as keyof UserOpLike] as string | number | undefined);
      if (v !== null && v > cap) {
        return { ok: false, reason: `${field} exceeds the sponsored cap` };
      }
    }
  }
  return { ok: true };
}

export type BudgetCheck = { ok: true } | { ok: false; reason: string };

/**
 * Rolling-24h spend ceiling, checked before sponsoring. Bounds total budget
 * drain even if an attacker mints many grants across many accounts/wallets:
 * a global cap and a per-minting-user cap, both count-based.
 */
export function checkSponsorBudget(userId: string): BudgetCheck {
  const since = Date.now() - DAY_MS;
  const total = (db.prepare(
    "SELECT COUNT(*) AS n FROM sponsored_ops WHERE created_at > ?",
  ).get(since) as { n: number }).n;
  if (total >= dailyCap()) {
    return { ok: false, reason: "daily sponsorship budget reached" };
  }
  const mine = (db.prepare(
    "SELECT COUNT(*) AS n FROM sponsored_ops WHERE user_id = ? AND created_at > ?",
  ).get(userId, since) as { n: number }).n;
  if (mine >= perUserDailyCap()) {
    return { ok: false, reason: "per-user sponsorship budget reached" };
  }
  return { ok: true };
}

/**
 * Consume a grant's one-time id. Returns true if THIS call claimed it (first
 * use), false if it was already spent (replay) — the caller then refuses to
 * sponsor. jti is the PRIMARY KEY so the INSERT is the atomic claim.
 */
export function consumeSponsorGrant(grant: SponsorGrant): boolean {
  try {
    db.prepare(
      "INSERT INTO sponsored_ops (jti, user_id, wallet, token, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(grant.jti, grant.sub, grant.wallet, grant.token, Date.now());
    return true;
  } catch (e) {
    if (/UNIQUE|PRIMARY/i.test((e as Error).message)) return false;
    throw e;
  }
}

/**
 * Release a just-consumed grant when OUR upstream paymaster call fails, so a
 * transient CDP hiccup doesn't burn a legitimate buyer's grant. Safe against
 * double-spend: the release only runs on our own fetch failure (never
 * attacker-timed), and any successful sponsorship leaves the jti consumed.
 */
export function releaseSponsorGrant(jti: string): void {
  try {
    db.prepare("DELETE FROM sponsored_ops WHERE jti = ?").run(jti);
  } catch {
    /* best-effort */
  }
}
