import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { resolveRole, atLeast } from "@/lib/access";
import { deleteInvite } from "@/lib/invites.js";

/** DELETE /api/drives/:driveId/members/invites/:inviteId — owner cancels a
 *  pending (pre-account) invite before the invitee signs up. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ driveId: string; inviteId: string }> },
) {
  const { driveId, inviteId } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });
  if (!atLeast(resolveRole(driveId, user.id, ""), "owner")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  deleteInvite(driveId, inviteId);
  return NextResponse.json({ ok: true });
}
