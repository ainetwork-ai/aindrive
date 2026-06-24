import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getUser } from "@/lib/session";
import { getDrive, payoutWalletFor } from "@/lib/drives";
import { resolveRole, atLeast } from "@/lib/access";
import { resolveDriveTokens } from "@/lib/payment-tokens";
import { decideShareEdit } from "@/lib/share-edit";

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

  const share = db
    .prepare("SELECT id, created_by FROM shares WHERE id = ? AND drive_id = ?")
    .get(shareId, driveId) as { id: string; created_by: string | null } | undefined;
  if (!share) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Owner can revoke any link; a non-owner only their own — and only while
  // still a member. created_by has no FK, so a removed editor whose id still
  // matches the column must NOT keep revoke rights after losing access.
  const myRole = resolveRole(driveId, user.id, "");
  const isOwner = atLeast(myRole, "owner");
  if (!isOwner && (!atLeast(myRole, "viewer") || share.created_by !== user.id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  db.prepare("DELETE FROM shares WHERE id = ? AND drive_id = ?").run(shareId, driveId);
  return NextResponse.json({ ok: true });
}

const PatchBody = z
  .object({
    price_usdc: z.number().positive().optional(),
    currency: z.string().optional(),
    listed: z.boolean().optional(),
  })
  .refine((b) => b.price_usdc !== undefined || b.currency !== undefined || b.listed !== undefined, {
    message: "no fields to update",
  });

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
  const body = PatchBody.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });

  const share = db
    .prepare("SELECT id, path, created_by, price_usdc, currency, listed FROM shares WHERE id = ? AND drive_id = ?")
    .get(shareId, driveId) as
    | { id: string; path: string; created_by: string | null; price_usdc: number | null; currency: string | null; listed: number }
    | undefined;
  if (!share) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Owner edits any share; a non-owner only one they created AND still hold
  // editor at its path for (create's editor floor + delete's creator/membership
  // check). created_by has no FK, so a removed editor whose id still matches the
  // column must NOT retain edit rights.
  const isOwner = atLeast(resolveRole(driveId, user.id, ""), "owner");
  if (
    !isOwner &&
    (share.created_by !== user.id || !atLeast(resolveRole(driveId, user.id, share.path), "editor"))
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const decision = decideShareEdit(
    { price_usdc: share.price_usdc, currency: share.currency, listed: share.listed === 1 },
    body.data,
    {
      allowedSymbols: resolveDriveTokens(drive.allowed_tokens).map((t) => t.symbol),
      payoutExists: !!payoutWalletFor(driveId, share.path),
      isOwner,
    },
  );
  if (!decision.ok) return NextResponse.json({ error: decision.error }, { status: decision.status });

  const { price_usdc, currency, listed } = decision.next;
  db.prepare("UPDATE shares SET price_usdc = ?, currency = ?, listed = ? WHERE id = ? AND drive_id = ?")
    .run(price_usdc, currency, listed, shareId, driveId);
  return NextResponse.json({ id: share.id, price_usdc, currency, listed });
}
