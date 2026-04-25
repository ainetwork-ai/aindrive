/**
 * GET /api/x402/lift?scope=<rate_limit|gemma_agent>&priceAin=<whole AIN>
 *
 * Flow:
 *   1. If wallet cookie present AND hasActiveLift → 200 { ok, lifted, expiresAt }
 *   2. If X-PAYMENT header present → verify on-chain; on success grant lift + 200
 *   3. Otherwise → 402 with payment requirements
 */

import { NextRequest, NextResponse } from "next/server";
import {
  buildPaymentRequirements,
  build402Body,
  parsePaymentSignature,
  encodePaymentResponse,
  verify,
} from "@/lib/x402-ain";
import { getActiveLiftExpiry, addLift, txHashUsed } from "@/lib/paid-lifts.js";
import { getWallet, setWalletCookie } from "@/lib/wallet";

const LIFT_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const scope = (searchParams.get("scope") ?? "rate_limit").trim();
  const priceAin = BigInt(searchParams.get("priceAin") ?? "1");
  // AIN decimals = 12
  const priceAinUnits = (priceAin * 10n ** 12n).toString();

  // 1. Already lifted?
  const wallet = await getWallet();
  if (wallet) {
    const expiresAt = getActiveLiftExpiry(wallet, scope);
    if (expiresAt != null) {
      return NextResponse.json({ ok: true, lifted: true, expiresAt });
    }
  }

  const resourceUrl = `${req.nextUrl.origin}/api/x402/lift?scope=${scope}&priceAin=${priceAin}`;
  const requirements = buildPaymentRequirements({
    scope,
    priceAinUnits,
    resource: resourceUrl,
  });

  // 2. Payment header present?
  const paymentHeader = req.headers.get("X-PAYMENT") ?? req.headers.get("PAYMENT-SIGNATURE");
  if (paymentHeader) {
    const payload = parsePaymentSignature(paymentHeader);
    if (!payload) {
      return respond402(requirements, resourceUrl, "malformed PAYMENT-SIGNATURE header");
    }

    // Sanitise error strings before returning to client
    function sanitiseError(raw: string): string {
      return raw.replace(/0x[0-9a-fA-F]+/g, "[hex]").slice(0, 200);
    }

    const result = await verify(payload, requirements);
    if (!result.ok) {
      return respond402(requirements, resourceUrl, sanitiseError(result.error));
    }

    const { payer, txHash } = result;

    // Double-check anti-replay (verify already calls txHashUsed but be safe)
    if (txHashUsed(txHash)) {
      return respond402(requirements, resourceUrl, "tx already used");
    }

    // Record lift
    addLift({ wallet: payer, scope, ttlMs: LIFT_TTL_MS, paymentTx: txHash });

    // Set wallet cookie
    await setWalletCookie(payer);

    const paymentResponse = encodePaymentResponse({ transaction: txHash, settledAt: Date.now() });

    return NextResponse.json(
      { ok: true, lifted: true, payer, txHash },
      {
        status: 200,
        headers: { "PAYMENT-RESPONSE": paymentResponse },
      }
    );
  }

  // 3. No payment — return 402
  return respond402(requirements, resourceUrl, "PAYMENT-SIGNATURE header required");
}

function respond402(
  requirements: ReturnType<typeof buildPaymentRequirements>,
  resourceUrl: string,
  error: string
) {
  const body = build402Body({
    requirements,
    resource: { url: resourceUrl },
    error,
  });
  return NextResponse.json(body, { status: 402 });
}
