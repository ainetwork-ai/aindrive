import { NextResponse } from "next/server";
import { z } from "zod";
import { isAddress } from "viem";
import { getUser } from "@/lib/session";
import { getDrive, setDrivePayoutWallet } from "@/lib/drives";

/**
 * PATCH /api/drives/:driveId
 *
 * Owner-only drive settings update. Currently supports payout_wallet — the
 * EVM address that receives x402 payments for this drive's paid shares.
 * Pass payout_wallet: null to clear it (falls back to the global env wallet).
 */
const Body = z.object({
  payout_wallet: z
    .string()
    .refine((v) => isAddress(v), "invalid address")
    .nullable(),
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
  const wallet = body.data.payout_wallet ? body.data.payout_wallet.toLowerCase() : null;
  setDrivePayoutWallet(driveId, wallet);
  return NextResponse.json({ ok: true, payout_wallet: wallet });
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
    payout_wallet: drive.payout_wallet,
  });
}
