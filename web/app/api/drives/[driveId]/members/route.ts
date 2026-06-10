import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "@/lib/db";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { resolveRole, atLeast } from "@/lib/access";
import { addInvite, listInvites } from "@/lib/invites.js";
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
  const members = db.prepare(`
    SELECT m.id, m.path, m.role, u.email, u.name
    FROM drive_members m JOIN users u ON u.id = m.user_id
    WHERE m.drive_id = ?
    ORDER BY m.created_at DESC
  `).all(driveId);
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
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });
  // Co-owners (owner role via drive_members) may also invite — not just the creator.
  if (!atLeast(resolveRole(driveId, user.id, ""), "owner")) return NextResponse.json({ error: "only owner can invite" }, { status: 403 });
  const invitee = db
    .prepare("SELECT id FROM users WHERE lower(email) = lower(?)")
    .get(body.data.email) as { id: string } | undefined;
  if (!invitee) {
    // No account yet → record a pending invite that converts to a grant on
    // signup, instead of dead-ending the owner with a 404.
    addInvite(driveId, body.data.email, body.data.path, body.data.role, user.id);
    return NextResponse.json({ ok: true, pending: true }, { status: 202 });
  }
  const id = nanoid(12);
  // Upgrade-only upsert: re-inviting an existing member must never lower
  // their role (mergeRoleUpgradeOnly, expressed inline in SQL). The CASE
  // mirrors ROLE_RANK (none<viewer<editor<owner); on conflict we keep
  // whichever of the existing role / the requested role ranks higher.
  db.prepare(`
    INSERT INTO drive_members (id, drive_id, user_id, path, role)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(drive_id, user_id, path) DO UPDATE SET role =
      CASE
        WHEN (CASE drive_members.role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END)
           > (CASE excluded.role       WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END)
        THEN drive_members.role
        ELSE excluded.role
      END
  `).run(id, driveId, invitee.id, body.data.path, body.data.role);
  return NextResponse.json({ ok: true });
}
