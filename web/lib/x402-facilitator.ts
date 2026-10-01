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

/**
 * What a failed call did with settle, for a caller that must know whether
 * money may have moved:
 *   - "not_sent": settle was never requested (verify refused, the facilitator
 *     was unreachable for verify, or `beforeSettle` stopped it).
 *   - "refused": ONE settle request was made and the facilitator answered it
 *     with a reason that is only ever given before anything is broadcast, and
 *     that the authorization having been used cannot cause
 *     (PRE_BROADCAST_REFUSALS). The authorization moved nothing.
 *   - "uncertain": anything else — a timeout, a network error, a retried
 *     settle request, a reverted or unknown outcome, or a reason (nonce
 *     already used, insufficient balance, expired, ...) that a broadcast of
 *     this very authorization could have caused.
 */
export type SettleState = "not_sent" | "refused" | "uncertain";

export type SettleOutcome =
  | { ok: true; payer: string; transaction: string; network: string; bypass: boolean }
  /** `status` is the HTTP status a resource should answer with: 402, or 412
   *  for a missing Permit2 allowance (a precondition, not a rejection). */
  | { ok: false; status: 402 | 412 | 503; reason: string; settle: SettleState }
  /** `beforeSettle` returned a reason: nothing was sent to settle. */
  | { ok: false; status: 409; reason: string; settle: "not_sent"; aborted: true };

/**
 * Settle refusals of the exact-EVM EIP-3009 facilitator (@x402/evm) that are
 * decided from the payload and static chain facts before any transaction is
 * sent, and that a mined use of the same authorization cannot produce (the
 * token checks validity window and "used" before the signature). Deliberately
 * absent: nonce already used, insufficient balance, valid-before expired,
 * simulation/transaction failed — each can be the answer to a retry after this
 * authorization was already broadcast — and any reason not listed here.
 */
export const PRE_BROADCAST_REFUSALS: ReadonlySet<string> = new Set([
  "invalid_exact_evm_scheme",
  "invalid_exact_evm_network_mismatch",
  "invalid_exact_evm_missing_eip712_domain",
  "invalid_exact_evm_recipient_mismatch",
  "invalid_exact_evm_signature",
  "invalid_exact_evm_payload_authorization_valid_after",
  "invalid_exact_evm_authorization_value",
  "invalid_exact_evm_payload_undeployed_smart_wallet",
  "invalid_exact_evm_token_name_mismatch",
  "invalid_exact_evm_token_version_mismatch",
  "invalid_exact_evm_eip3009_not_supported",
  "eip6492_factory_not_allowed",
  "unsupported_payload_type",
]);

export type SettleOptions = {
  /**
   * Runs after verify passed and right before the first settle request — the
   * last point where nothing can have been broadcast. Returns null to settle,
   * or a reason to stop (outcome `aborted`, status 409). A throw also stops
   * (503, nothing sent).
   */
  beforeSettle?: () => string | null;
};

function runBeforeSettle(opts: SettleOptions): SettleOutcome | null {
  if (!opts.beforeSettle) return null;
  try {
    const reason = opts.beforeSettle();
    return reason === null ? null : { ok: false, status: 409, reason, settle: "not_sent", aborted: true };
  } catch (e) {
    console.error("[x402] beforeSettle failed — not settling", e);
    return { ok: false, status: 503, reason: "the payment could not be recorded, nothing was charged — please retry", settle: "not_sent" };
  }
}

/** A settle answer (2xx body or @x402/core SettleError) refusing before broadcast. */
function refusedBeforeBroadcast(answer: { errorReason?: unknown; transaction?: unknown }): boolean {
  return typeof answer.errorReason === "string"
    && PRE_BROADCAST_REFUSALS.has(answer.errorReason)
    && !answer.transaction;
}

/**
 * verify (10 s, one retry on facilitator error) → settle (15 s, one retry).
 * `label` only tags the diagnostic log line. `opts.beforeSettle` runs between
 * the two (lib/x402-account-settlements.js records a purchase attempt there).
 */
export async function verifyAndSettle(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  label = "x402",
  opts: SettleOptions = {},
): Promise<SettleOutcome> {
  if (DEV_BYPASS) {
    const stop = runBeforeSettle(opts);
    if (stop) return stop;
    const payer = (payerFromPayload(payload) || "0xdemodemodemodemodemodemodemodemodemo0000").toLowerCase();
    console.warn(`[x402 DEV BYPASS] accepting ${label} from ${payer}`);
    return { ok: true, payer, transaction: "0xdev_bypass_" + nanoid(20), network: requirements.network, bypass: true };
  }
  const config = resolveFacilitatorConfig();
  if (!config) {
    console.error("[x402] no facilitator configured for mainnet — set AINDRIVE_X402_FACILITATOR or CDP_API_KEY_ID/SECRET");
    return { ok: false, status: 503, reason: "payments are not configured on this server", settle: "not_sent" };
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
      return { ok: false, status: 402, reason: "facilitator unavailable, please retry", settle: "not_sent" };
    }
  }
  if (!verifyRes) return { ok: false, status: 402, reason: "facilitator unavailable, please retry", settle: "not_sent" };
  if (!verifyRes.isValid) {
    const reason = verifyRes.invalidReason || "verification failed";
    return { ok: false, status: reason === "permit2_allowance_required" ? 412 : 402, reason, settle: "not_sent" };
  }
  const stop = runBeforeSettle(opts);
  if (stop) return stop;

  type SettleResult = Awaited<ReturnType<typeof facilitator.settle>>;
  let settleRes: SettleResult | null = null;
  // Requests sent so far: an answer to a RETRY is never a pre-broadcast refusal
  // (the earlier request may have timed out after broadcasting).
  let sent = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    sent++;
    const r = await withTimeout<SettleResult>(15_000, () => facilitator.settle(payload, requirements));
    if (r.ok) { settleRes = r.value; break; }
    if (!isFacilitatorUnavailable(r.error) || attempt === 1) {
      diag("settle", r, attempt);
      // A non-2xx answer with a settle body (@x402/core SettleError) is still the facilitator's answer.
      const answer = r.error as { name?: string; errorReason?: unknown; transaction?: unknown };
      if (answer?.name === "SettleError" && sent === 1 && !r.timedOut && refusedBeforeBroadcast(answer)) {
        return { ok: false, status: 402, reason: sanitizeSettleError(String(answer.errorReason)), settle: "refused" };
      }
      return { ok: false, status: 402, reason: "facilitator unavailable, please retry", settle: "uncertain" };
    }
  }
  if (!settleRes) return { ok: false, status: 402, reason: "facilitator unavailable, please retry", settle: "uncertain" };
  if (!settleRes.success) {
    const reason = sanitizeSettleError(settleRes.errorReason || "settlement failed");
    return { ok: false, status: 402, reason, settle: sent === 1 && refusedBeforeBroadcast(settleRes) ? "refused" : "uncertain" };
  }
  return {
    ok: true,
    payer: (settleRes.payer || payerFromPayload(payload) || "0x0").toLowerCase(),
    transaction: settleRes.transaction,
    network: settleRes.network ?? requirements.network,
    bypass: false,
  };
}
