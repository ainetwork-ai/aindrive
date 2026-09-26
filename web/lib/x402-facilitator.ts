/**
 * The x402 facilitator this server settles through — one resolution and one
 * verify→settle routine, shared by the paid-share checkout
 * (app/api/s/[token]) and the `x402_settle` skill (lib/x402-pay-skills.ts).
 *
 * Resolution, in priority order: explicit AINDRIVE_X402_FACILITATOR URL
 * (self-hosted or any third party), CDP API keys (Coinbase facilitator — URL +
 * per-request JWT auth built in), then the public x402.org default on testnet
 * only. Mainnet has NO default — silently settling real money through a
 * guessed facilitator is exactly the failure mode we refuse. Server-only env
 * (never NEXT_PUBLIC).
 *
 * AINDRIVE_DEV_BYPASS_X402=1 skips the facilitator: any well-formed payload
 * "settles" with a synthetic tx hash, so local demos need no real signature.
 */
import { nanoid } from "nanoid";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { createFacilitatorConfig } from "@coinbase/x402";
import { paymentNetwork } from "./payment-tokens";

export type FacilitatorConfig = ConstructorParameters<typeof HTTPFacilitatorClient>[0];

export function resolveFacilitatorConfig(): FacilitatorConfig | null {
  if (process.env.AINDRIVE_X402_FACILITATOR) return { url: process.env.AINDRIVE_X402_FACILITATOR };
  if (process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET) {
    return createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET);
  }
  return paymentNetwork() === "mainnet" ? null : { url: "https://x402.org/facilitator" };
}

export const DEV_BYPASS = process.env.AINDRIVE_DEV_BYPASS_X402 === "1";

/** This server can settle: a facilitator is configured, or the dev bypass is on. */
export function canSettle(): boolean {
  return DEV_BYPASS || resolveFacilitatorConfig() !== null;
}

/** Payer address from a v2 exact-evm payload: eip3009 payloads carry
 *  authorization.from, permit2 payloads permit2Authorization.from. */
export function payerFromPayload(payload: PaymentPayload): string | undefined {
  const p = payload?.payload as
    | { authorization?: { from?: string }; permit2Authorization?: { from?: string } }
    | undefined;
  return p?.authorization?.from ?? p?.permit2Authorization?.from;
}

/** Strip wallet addresses and cap length for safe user-facing messages. */
export function sanitizeSettleError(msg: string): string {
  return msg.replace(/0x[0-9a-fA-F]{40,}/g, "0x…").slice(0, 200);
}

async function withTimeout<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; timedOut: boolean; error: unknown }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return { ok: true, value: await fn(ac.signal) };
  } catch (e) {
    return { ok: false, timedOut: ac.signal.aborted, error: e };
  } finally {
    clearTimeout(timer);
  }
}

/** True for network/timeout errors that warrant a retry. */
function isFacilitatorUnavailable(e: unknown): boolean {
  if (e instanceof Error) {
    const n = e.name;
    return n === "AbortError" || n === "TimeoutError" || n === "TypeError";
  }
  return false;
}

export type SettleOutcome =
  | { ok: true; payer: string; transaction: string; network: string; bypass: boolean }
  /** `status` is the HTTP status a resource should answer with: 402, or 412
   *  for a missing Permit2 allowance (a precondition, not a rejection). */
  | { ok: false; status: 402 | 412 | 503; reason: string };

/**
 * verify (10 s, one retry on facilitator error) → settle (15 s, one retry).
 * `label` only tags the diagnostic log line.
 */
export async function verifyAndSettle(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  label = "x402",
): Promise<SettleOutcome> {
  if (DEV_BYPASS) {
    const payer = (payerFromPayload(payload) || "0xdemodemodemodemodemodemodemodemodemo0000").toLowerCase();
    console.warn(`[x402 DEV BYPASS] accepting ${label} from ${payer}`);
    return { ok: true, payer, transaction: "0xdev_bypass_" + nanoid(20), network: requirements.network, bypass: true };
  }
  const config = resolveFacilitatorConfig();
  if (!config) {
    console.error("[x402] no facilitator configured for mainnet — set AINDRIVE_X402_FACILITATOR or CDP_API_KEY_ID/SECRET");
    return { ok: false, status: 503, reason: "payments are not configured on this server" };
  }
  const facilitator = new HTTPFacilitatorClient(config);
  const diag = (stage: string, r: { timedOut: boolean; error: unknown }, attempt: number) =>
    console.error(`[x402-diag] ${stage}-fail ${label} net=${requirements.network} timedOut=${r.timedOut} attempt=${attempt} name=${(r.error as Error)?.name} status=${(r.error as { status?: number })?.status ?? "-"} msg=${sanitizeSettleError(String((r.error as Error)?.message ?? r.error))}`);

  type VerifyResult = Awaited<ReturnType<typeof facilitator.verify>>;
  let verifyRes: VerifyResult | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await withTimeout<VerifyResult>(10_000, () => facilitator.verify(payload, requirements));
    if (r.ok) { verifyRes = r.value; break; }
    if (!isFacilitatorUnavailable(r.error) || attempt === 1) {
      diag("verify", r, attempt);
      return { ok: false, status: 402, reason: "facilitator unavailable, please retry" };
    }
  }
  if (!verifyRes) return { ok: false, status: 402, reason: "facilitator unavailable, please retry" };
  if (!verifyRes.isValid) {
    const reason = verifyRes.invalidReason || "verification failed";
    return { ok: false, status: reason === "permit2_allowance_required" ? 412 : 402, reason };
  }

  type SettleResult = Awaited<ReturnType<typeof facilitator.settle>>;
  let settleRes: SettleResult | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await withTimeout<SettleResult>(15_000, () => facilitator.settle(payload, requirements));
    if (r.ok) { settleRes = r.value; break; }
    if (!isFacilitatorUnavailable(r.error) || attempt === 1) {
      diag("settle", r, attempt);
      return { ok: false, status: 402, reason: "facilitator unavailable, please retry" };
    }
  }
  if (!settleRes) return { ok: false, status: 402, reason: "facilitator unavailable, please retry" };
  if (!settleRes.success) {
    return { ok: false, status: 402, reason: sanitizeSettleError(settleRes.errorReason || "settlement failed") };
  }
  return {
    ok: true,
    payer: (settleRes.payer || payerFromPayload(payload) || "0x0").toLowerCase(),
    transaction: settleRes.transaction,
    network: settleRes.network ?? requirements.network,
    bypass: false,
  };
}
