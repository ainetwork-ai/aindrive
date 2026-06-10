import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { resolveRole, atLeast } from "@/lib/access";
import { canRemoveMember } from "@/lib/member-guard";

const PatchBody = z.object({
  role: z.enum(["viewer", "editor", "owner"]),
});

type MemberRow = { id: string; user_id: string };

/** Load the target row, scoped to this drive so a foreign memberId 404s. */
function getMemberRow(driveId: string, memberId: string): MemberRow | undefined {
  return db
    .prepare("SELECT id, user_id FROM drive_members WHERE id = ? AND drive_id = ?")
    .get(memberId, driveId) as MemberRow | undefined;
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ driveId: string; memberId: string }> },
) {
  const { driveId, memberId } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });
  if (!atLeast(resolveRole(driveId, user.id, ""), "owner")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const member = getMemberRow(driveId, memberId);
  if (!member) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!canRemoveMember({ memberUserId: member.user_id, driveOwnerId: drive.owner_id })) {
    return NextResponse.json({ error: "cannot remove the drive creator" }, { status: 400 });
  }
  db.prepare("DELETE FROM drive_members WHERE id = ? AND drive_id = ?").run(memberId, driveId);
  return NextResponse.json({ ok: true });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ driveId: string; memberId: string }> },
) {
  const { driveId, memberId } = await params;
  const body = PatchBody.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });
  if (!atLeast(resolveRole(driveId, user.id, ""), "owner")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const member = getMemberRow(driveId, memberId);
  if (!member) return NextResponse.json({ error: "not found" }, { status: 404 });
  // The creator's role row is immutable (same guard as DELETE): a co-owner must
  // not be able to demote the creator or rewrite their path-scoped grants.
  if (!canRemoveMember({ memberUserId: member.user_id, driveOwnerId: drive.owner_id })) {
    return NextResponse.json({ error: "cannot change the drive creator's role" }, { status: 400 });
  }
  // Explicit set (may downgrade) — distinct from CONSUME's upgrade-only merge.
  db.prepare("UPDATE drive_members SET role = ? WHERE id = ? AND drive_id = ?")
    .run(body.data.role, memberId, driveId);
  return NextResponse.json({ ok: true, role: body.data.role });
}
