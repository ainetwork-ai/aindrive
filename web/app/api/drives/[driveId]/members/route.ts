import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { resolveRole, atLeast } from "@/lib/access";
import { listInvites } from "@/lib/invites.js";
import { grantByEmail } from "@/lib/drive-sharing";
import { zPath } from "@/lib/zod-helpers";

const Body = z.object({
  email: z.string().email(),
  path: zPath.default(""),
  role: z.enum(["viewer", "editor", "owner"]),
});

export async function GET(_req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const role = resolveRole(driveId, user.id, "");
  if (!atLeast(role, "editor")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const rows = db.prepare(`
    SELECT m.id, m.path, m.role, m.user_id, u.email, u.name
    FROM drive_members m JOIN users u ON u.id = m.user_id
    WHERE m.drive_id = ?
    ORDER BY m.created_at DESC
  `).all(driveId) as { id: string; path: string; role: string; user_id: string; email: string; name: string }[];
  // Flag the creator's grants so the UI can lock the controls the backend
  // always rejects (the creator row can't be demoted/removed — see
  // members/[memberId] canRemoveMember). This is the ONE structural specialness
  // of the creator (an undeletable anchor so a drive can't be orphaned); it is
  // not a financial/role privilege.
  const ownerId = getDrive(driveId)?.owner_id ?? null;
  const members = rows.map(({ user_id, ...m }) => ({ ...m, isCreator: user_id === ownerId }));
  // Pending invites are an owner-only concern (they expose invited emails).
  const pending = atLeast(role, "owner") ? listInvites(driveId) : [];
  return NextResponse.json({ members, pending, myRole: role });
}

export async function POST(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const body = Body.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Same rules for the OAuth route (app/api/oauth/drives/[driveId]/members): lib/drive-sharing.ts.
  const r = grantByEmail({ driveId, actorId: user.id, email: body.data.email, path: body.data.path, role: body.data.role });
  return NextResponse.json(r.body, { status: r.status });
}
