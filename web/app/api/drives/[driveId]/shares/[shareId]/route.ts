import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { ShareEditBody, editShare, revokeShare } from "@/lib/sales";

/**
 * DELETE /api/drives/:driveId/shares/:shareId — revoke a share link.
 *
 * The row is deleted, so GET /s/<token> immediately 404s. Access already
 * granted through this link (drive_members rows, payment receipts) is
 * deliberately untouched — revoking the link stops NEW redemptions, it does
 * not claw back what people already accepted or paid for.
 *
 * Allowed for the drive owner, or the share's own creator (an editor can
 * revoke a link they minted).
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ driveId: string; shareId: string }> },
) {
  const { driveId, shareId } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });

  // Owner can revoke any link; a non-owner only their own — and only while
  // still a member (created_by has no FK). Shared with the MCP delete_share tool.
  const r = revokeShare(driveId, user.id, shareId);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true });
}

/**
 * PATCH /api/drives/:driveId/shares/:shareId — edit a share's sale terms
 * (price / currency / storefront `listed`). The /s/<token> link is preserved
 * and already-granted access (drive_members) is untouched: a paid share's price
 * is read live on every redemption and the payment is verified against it, so
 * mutating these columns in place is safe — only what NEW buyers are quoted
 * changes. Free⇄paid is out of scope: the schema forbids price <= 0, so a sale
 * can be repriced but never nulled out (go free via revoke + recreate).
 *
 * Auth mirrors create + delete: the owner may edit any share; a non-owner only
 * one they created AND still hold editor at its path for. Storefront listing
 * stays owner-only — enforced in decideShareEdit ([rev2-D]), alongside the
 * currency-policy and payout-wallet gates create applies.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ driveId: string; shareId: string }> },
) {
  const { driveId, shareId } = await params;
  const body = ShareEditBody.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });

  // Owner edits any share; a non-owner only one they created AND still hold
  // editor at its path for. lib/sales.ts editShare, shared with the MCP
  // update_share tool.
  const r = editShare(drive, user.id, shareId, body.data);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ id: r.id, price_usdc: r.price_usdc, currency: r.currency, listed: r.listed });
}
