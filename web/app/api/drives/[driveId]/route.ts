import { NextResponse } from "next/server";
import { z } from "zod";
import { isAddress } from "viem";
import { getUser } from "@/lib/session";
import { getDrive, setDrivePayoutWallet, setDriveAllowedTokens, getDriveRootPayoutWallet, listPayoutWallets } from "@/lib/drives";
import { validateTokenPolicy } from "@/lib/sales";
import { db } from "@/lib/db";
import { disconnectAgent } from "@/lib/agents.js";

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
  // shape is checked below with validateTokenPolicy (strict: garbage → 400).
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
    const policy = validateTokenPolicy(body.data.allowed_tokens);
    if (!policy.ok) return NextResponse.json({ error: policy.error }, { status: policy.status });
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

/**
 * DELETE /api/drives/:driveId — delete a drive for good. Creator only (a
 * co-owner can manage the drive but not end it — `leave` is their exit).
 *
 * Removes the drive row; members, shares, invites, receipts, payout wallets,
 * upload sessions and remote-MCP tokens/codes go with it via ON DELETE CASCADE
 * (lib/db.js). The files
 * themselves are untouched: they live on the agent's machine, which is simply
 * disconnected and refused on its next reconnect. Counts against the
 * per-user drive limit (POST /api/drives) are freed immediately — this is the
 * only way a limit-bound account gets a slot back.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });
  if (drive.owner_id !== user.id) {
    return NextResponse.json({ error: "only the drive creator can delete it" }, { status: 403 });
  }
  disconnectAgent(driveId);
  db.prepare("DELETE FROM drives WHERE id = ?").run(driveId);
  return NextResponse.json({ ok: true });
}
