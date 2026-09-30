import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { orgRoleInDrive } from "@/lib/orgs.js";
import { onMemberRevoked } from "@/lib/share-events";

/**
 * POST /api/drives/:driveId/leave — remove MYSELF from a drive.
 *
 * Deletes every drive_members row I hold (the root role and all path-scoped
 * grants), so the drive disappears from my list and my access ends. This is
 * the self-service counterpart of the owner-side member removal
 * (DELETE members/:memberId) and shares its one invariant: the creator can
 * never be removed — they delete the drive instead, because a creator-less
 * drive would have nobody able to manage payouts/policy.
 *
 * Leaving forfeits access bought through a paid share (the purchase grants a
 * member row; we delete it like any other). Rejoining needs a new invite or
 * share link — the UI warns before calling.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });
  if (drive.owner_id === user.id) {
    return NextResponse.json(
      { error: "the drive creator cannot leave — delete the drive instead" },
      { status: 400 },
    );
  }
  const paths = (db
    .prepare("SELECT path FROM drive_members WHERE drive_id = ? AND user_id = ?")
    .all(driveId, user.id) as { path: string }[]).map((r) => r.path);
  const res = db
    .prepare("DELETE FROM drive_members WHERE drive_id = ? AND user_id = ?")
    .run(driveId, user.id);
  if (res.changes === 0) {
    // Access through an organization is the organization's, not a grant to
    // give back: it ends when the drive's creator unshares it or the person
    // leaves the organization (lib/orgs.js).
    if (orgRoleInDrive(driveId, user.id) !== "none") {
      return NextResponse.json(
        { error: "you have this drive through your organization — only its owner can stop sharing it with the organization" },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: "not a member of this drive" }, { status: 404 });
  }
  // Change feed: one `file.revoked` per grant path I held (my own consumers hide them).
  onMemberRevoked(driveId, user.id, paths);
  return NextResponse.json({ ok: true });
}
