import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { unshareDriveFromOrg } from "@/lib/orgs.js";

/**
 * DELETE /api/drives/:driveId/orgs/:orgId — stop sharing the drive with an
 * organization. Creator only, always allowed (taking access back needs no org
 * role). Its members lose access at once; their open editors close.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ driveId: string; orgId: string }> }) {
  const { driveId, orgId } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });
  if (drive.owner_id !== user.id) {
    return NextResponse.json({ error: "only the drive creator can stop sharing it with an organization" }, { status: 403 });
  }
  const removed = unshareDriveFromOrg({ driveId, orgId, actor: `user:${user.id}`, actorUserId: user.id });
  if (removed === 0) return NextResponse.json({ error: "not shared with that organization" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
