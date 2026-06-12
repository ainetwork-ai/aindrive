import { NextResponse } from "next/server";
import { z } from "zod";
import { isAddress } from "viem";
import { getUser } from "@/lib/session";
import { getDrive, setDrivePayoutWallet, setDriveAllowedTokens, getDriveRootPayoutWallet, listPayoutWallets } from "@/lib/drives";
import { parseTokenPolicy, policyChainViolation } from "@/lib/payment-tokens";

/**
 * PATCH /api/drives/:driveId
 *
 * Owner-only drive settings update. Fields are independent — send only the
 * ones you're changing:
 * - payout_wallet: EVM address that receives x402 payments for paid shares at
 *   the drive root. This is just the root ("") row of the path-scoped payout
 *   table (lib/payout.ts); per-folder overrides go through
 *   PUT /api/drives/:id/payout. null clears the root row (paid shares with no
 *   covering ancestor wallet are then blocked at creation — no operator fallback).
 * - allowed_tokens: JSON string of PaymentToken[] — the drive's payment-token
 *   policy (spec D3). null clears it (policy reads as DEFAULT_TOKENS).
 */
const Body = z.object({
  payout_wallet: z
    .string()
    .refine((v) => isAddress(v), "invalid address")
    .nullable()
    .optional(),
  // Serialized policy — zod can't see inside the string, so the PaymentToken[]
  // shape is checked below with parseTokenPolicy (strict: garbage → 400).
  allowed_tokens: z.string().nullable().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const body = Body.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = getDrive(driveId);
  if (!drive || drive.owner_id !== user.id) {
    return NextResponse.json({ error: "only owner can change drive settings" }, { status: 403 });
  }
  // Validate everything before writing anything — a 400 must not leave a
  // half-applied multi-field PATCH.
  if (body.data.allowed_tokens != null) {
    const policy = parseTokenPolicy(body.data.allowed_tokens);
    if (!policy) {
      return NextResponse.json({ error: "invalid token policy" }, { status: 400 });
    }
    const badChain = policyChainViolation(policy);
    if (badChain) {
      return NextResponse.json(
        { error: `${badChain} tokens cannot be accepted on a mainnet deployment` },
        { status: 400 },
      );
    }
  }
  const updated: { payout_wallet?: string | null; allowed_tokens?: string | null } = {};
  if (body.data.payout_wallet !== undefined) {
    const wallet = body.data.payout_wallet ? body.data.payout_wallet.toLowerCase() : null;
    setDrivePayoutWallet(driveId, wallet);
    updated.payout_wallet = wallet;
  }
  if (body.data.allowed_tokens !== undefined) {
    setDriveAllowedTokens(driveId, body.data.allowed_tokens);
    updated.allowed_tokens = body.data.allowed_tokens;
  }
  return NextResponse.json({ ok: true, ...updated });
}

export async function GET(_req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = getDrive(driveId);
  if (!drive || drive.owner_id !== user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({
    id: drive.id,
    name: drive.name,
    // Root ("") wallet for back-compat; the full per-path list drives the new
    // folder-scoped payout UI.
    payout_wallet: getDriveRootPayoutWallet(driveId),
    payout_wallets: listPayoutWallets(driveId),
    allowed_tokens: drive.allowed_tokens,
  });
}
