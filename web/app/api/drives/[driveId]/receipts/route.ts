import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";

/**
 * GET /api/drives/:driveId/receipts
 *
 * Returns the full payment ledger for a drive, newest first. Owner-only.
 * Use cases: refund disputes, accounting, audit trail.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = getDrive(driveId);
  if (!drive || drive.owner_id !== user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const rows = db
    .prepare(
      "SELECT id, path, wallet, tx_hash, amount_usdc, network, share_id, settled_at FROM payment_receipts WHERE drive_id = ? ORDER BY settled_at DESC",
    )
    .all(driveId);
  return NextResponse.json({ receipts: rows });
}
