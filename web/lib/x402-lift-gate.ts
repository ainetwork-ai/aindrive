/**
 * x402 v2 paywall gate, sharable across routes.
 *
 *   const gate = await requireLift(req, { scope: "gemma_agent", priceAin: 5 });
 *   if (!gate.ok) return gate.response;  // either 402 (paywall) or 500 (verify error)
 *
 * Resolution order:
 *   1. Wallet cookie present + active lift in `paid_lifts` → ok.
 *   2. X-PAYMENT header present → verify on chain → record lift → ok.
 *   3. Otherwise → 402 with x402 v2 PaymentRequirements pointing back at this URL.
 *
 * Lift TTL defaults to 1 year for one-shot feature unlocks (gemma_agent),
 * shorter for rate-limit lifts.
 */

import { NextResponse } from "next/server";
import {
  buildPaymentRequirements,
  build402Body,
  parsePaymentSignature,
  encodePaymentResponse,
  verify,
  type PaymentRequirements,
} from "@/lib/x402-ain";
import { getActiveLiftExpiry, addLift } from "@/lib/paid-lifts.js";
import { getWallet, setWalletCookie } from "@/lib/wallet";

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export type LiftGateOptions = {
  scope: string;
  /** Price in whole AIN tokens (decimals=12). E.g. `5` = 5 AIN. */
  priceAin: number;
  description?: string;
  ttlMs?: number;
};

export type LiftGateResult =
  | { ok: true; payer?: string; expiresAt: number | null; settledTx?: string }
  | { ok: false; response: NextResponse };

export async function requireLift(
  req: Request,
  opts: LiftGateOptions,
): Promise<LiftGateResult> {
  const requirements: PaymentRequirements = buildPaymentRequirements({
    scope: opts.scope,
    priceAinUnits: (BigInt(opts.priceAin) * 10n ** 12n).toString(),
    resource: req.url as `${string}://${string}`,
    description: opts.description ?? `aindrive: lift ${opts.scope}`,
  });

  // 1. Already lifted via wallet cookie?
  const wallet = await getWallet();
  if (wallet) {
    const expiresAt = getActiveLiftExpiry(wallet, opts.scope);
    if (expiresAt != null) {
      return { ok: true, payer: wallet, expiresAt };
    }
  }

  // 2. Inline payment via X-PAYMENT header.
  const xPayment = req.headers.get("x-payment");
  if (xPayment) {
    const payload = parsePaymentSignature(xPayment);
    if (!payload) {
      return paywallResponse(req, requirements, "invalid X-PAYMENT envelope");
    }
    const v = await verify(payload, requirements);
    if (!v.ok) {
      return paywallResponse(req, requirements, v.error || "payment verify failed");
    }
    addLift({
      wallet: v.payer,
      scope: opts.scope,
      ttlMs: opts.ttlMs ?? ONE_YEAR_MS,
      paymentTx: v.txHash,
    });
    await setWalletCookie(v.payer);
    const expiresAt = getActiveLiftExpiry(v.payer, opts.scope);
    const headers = new Headers();
    headers.set(
      "PAYMENT-RESPONSE",
      encodePaymentResponse({ transaction: v.txHash, settledAt: Date.now() }),
    );
    // Caller should attach these headers to its success response if it cares.
    return { ok: true, payer: v.payer, expiresAt, settledTx: v.txHash };
  }

  return paywallResponse(req, requirements, "PAYMENT-SIGNATURE header required");
}

function paywallResponse(
  req: Request,
  requirements: PaymentRequirements,
  error: string,
): LiftGateResult {
  const body = build402Body({
    requirements,
    resource: { url: req.url, description: requirements.description, mimeType: "application/json" },
    error,
  });
  return {
    ok: false,
    response: NextResponse.json(body, { status: 402 }),
  };
}
