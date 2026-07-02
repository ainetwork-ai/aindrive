import { NextResponse } from "next/server";
import { z } from "zod";
import { maxUint256 } from "viem";
import { db } from "@/lib/db";
import { getUser } from "@/lib/session";
import { mintSponsorGrant, paymasterEnabled, checkSponsorBudget } from "@/lib/paymaster";
import { tryConsume } from "@/lib/rate-limit.js";
import { TOKEN_PRESETS, resolveDriveTokens, toCaip2Network, policyChainViolation } from "@/lib/payment-tokens";

// Mint a sponsor grant for one permit2 purchase: the signed voucher the
// paymaster proxy (app/api/paymaster) demands before it will sponsor the
// buyer's approve(Permit2) gas. Deliberately session-gated and share-derived —
// the grant's asset/amount/chain come from the share's CURRENT quote (same
// resolution as the 402 in app/api/s/[token]), never from the client, so a
// grant can only ever sponsor the approve the sale actually needs.
const Body = z.object({
  token: z.string().min(1),
  wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

export async function POST(req: Request) {
  if (!paymasterEnabled()) {
    return NextResponse.json({ error: "gas sponsorship not configured" }, { status: 503 });
  }
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });

  // Per-user mint budget: a buyer needs 1 grant per purchase attempt; 30/hour
  // absorbs retries while capping how fast one account can farm sponsorship.
  const rl = tryConsume({ name: "paymaster-grant", key: user.id, limit: 30, windowMs: 60 * 60 * 1000 });
  if (!rl.ok) {
    return NextResponse.json({ error: "too many sponsorship requests, retry later" }, { status: 429 });
  }
  // Refuse to mint once the rolling-24h budget (global or this user's) is spent —
  // fail here so the client degrades to self-pay before prompting the wallet,
  // rather than minting a grant the proxy would later reject.
  const budget = checkSponsorBudget(user.id);
  if (!budget.ok) {
    return NextResponse.json({ error: budget.reason }, { status: 429 });
  }

  const share = db.prepare(`
    SELECT s.path, s.expires_at, s.price_usdc, s.currency, d.allowed_tokens
    FROM shares s JOIN drives d ON d.id = s.drive_id
    WHERE s.token = ?
  `).get(body.data.token) as
    | { path: string; expires_at: string | null; price_usdc: number | null; currency: string | null; allowed_tokens: string | null }
    | undefined;
  if (!share || !share.price_usdc) {
    return NextResponse.json({ error: "not a paid share" }, { status: 404 });
  }
  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    return NextResponse.json({ error: "share expired" }, { status: 410 });
  }

  // Same token resolution as the share 402 (app/api/s/[token]): policy-checked,
  // legacy NULL currency → USDC preset (which is eip3009 → refused below).
  const tokens = resolveDriveTokens(share.allowed_tokens);
  const tok = share.currency == null
    ? TOKEN_PRESETS.USDC
    : tokens.find((t) => t.symbol === share.currency);
  if (!tok || tok.transferMethod !== "permit2") {
    // eip3009 tokens (USDC) never need an approve — nothing to sponsor.
    return NextResponse.json({ error: "sale does not use a permit2 token" }, { status: 409 });
  }
  if (policyChainViolation([tok])) {
    return NextResponse.json({ error: "token chain not settleable on this deployment" }, { status: 503 });
  }

  const chainId = Number(toCaip2Network(tok.chain).split(":")[1]);
  // We sponsor a MaxUint256 (unlimited) approve to Permit2, matching the x402
  // SDK default. Permit2's SignatureTransfer draws down this ERC-20 allowance
  // per settle, so an exact-amount approve would force (and need sponsoring for)
  // a fresh approve on EVERY purchase; a max approve is one-time per wallet, so
  // the buyer never re-approves and we sponsor at most once per wallet. Safe:
  // any actual transfer still needs the buyer's per-purchase Permit2 signature.
  // `amount` here is the APPROVE amount the proxy will enforce (not the price).
  const amount = maxUint256.toString();
  const grant = mintSponsorGrant({
    userId: user.id, token: body.data.token, wallet: body.data.wallet, asset: tok.asset, chainId, amount,
  });
  // asset/amount/chainId are echoed so the client builds the approve from the
  // SAME values the proxy will enforce.
  return NextResponse.json({ grant, asset: tok.asset, amount, chainId });
}
