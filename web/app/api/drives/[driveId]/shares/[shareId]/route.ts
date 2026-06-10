import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { resolveRole, atLeast } from "@/lib/access";

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

  const isOwner = atLeast(resolveRole(driveId, user.id, ""), "owner");
  if (!isOwner && share.created_by !== user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  db.prepare("DELETE FROM shares WHERE id = ? AND drive_id = ?").run(shareId, driveId);
  return NextResponse.json({ ok: true });
}
