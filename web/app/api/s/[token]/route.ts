import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWallet } from "@/lib/wallet";
import { getUser } from "@/lib/session";

type ShareRow = {
  id: string;
  drive_id: string;
  path: string;
  role: string;
  expires_at: string | null;
  price_usdc: number | null;
  payment_chain: string | null;
};

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const share = db.prepare(`
    SELECT s.id, s.drive_id, s.path, s.role, s.expires_at, s.price_usdc, s.payment_chain,
           d.name AS drive_name, d.owner_id
    FROM shares s JOIN drives d ON d.id = s.drive_id
    WHERE s.token = ?
  `).get(token) as (ShareRow & { drive_name: string; owner_id: string }) | undefined;
  if (!share) return NextResponse.json({ error: "share not found" }, { status: 404 });
  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    return NextResponse.json({ error: "share expired" }, { status: 410 });
  }

  // Owner is always allowed
  const user = await getUser();
  if (user && user.id === share.owner_id) {
    return NextResponse.json({ ok: true, driveId: share.drive_id, driveName: share.drive_name, path: share.path });
  }

  // Free share: anyone with the link
  if (!share.price_usdc) {
    return NextResponse.json({ ok: true, driveId: share.drive_id, driveName: share.drive_name, path: share.path });
  }

  // Paid share: must have wallet + be in folder_access
  const wallet = await getWallet();
  if (wallet) {
    const granted = db.prepare(
      "SELECT 1 FROM folder_access WHERE drive_id = ? AND path = ? AND wallet_address = ?"
    ).get(share.drive_id, share.path, wallet);
    if (granted) {
      return NextResponse.json({ ok: true, driveId: share.drive_id, driveName: share.drive_name, path: share.path });
    }
  }

  // Not paid: x402 challenge
  // Owner's payout address: for MVP we ask the owner to set a payout wallet on their account.
  // Since we don't have that yet, we use a placeholder. The middleware can later read it from a
  // `users.payout_wallet` column.
  const payTo = process.env.AINDRIVE_PAYOUT_WALLET || "0x0000000000000000000000000000000000000000";
  const requirements = {
    scheme: "exact",
    network: share.payment_chain || "base-sepolia",
    asset: "USDC",
    amount: share.price_usdc,
    recipient: payTo,
    description: `Access to share ${token}`,
    facilitator: process.env.AINDRIVE_X402_FACILITATOR || "https://x402.org/facilitator",
    payTo: `/api/s/${token}/pay`,
  };
  return NextResponse.json(
    { error: "payment required", paymentRequirements: requirements, walletConnected: !!wallet },
    {
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": JSON.stringify(requirements),
        "Content-Type": "application/json",
      },
    }
  );
}
