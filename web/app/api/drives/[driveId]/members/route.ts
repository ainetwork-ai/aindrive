import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "@/lib/db";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { resolveRole, atLeast } from "@/lib/access";

const Body = z.object({
  email: z.string().email(),
  path: z.string().default(""),
  role: z.enum(["viewer", "commenter", "editor", "owner"]),
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
  return NextResponse.json({ members });
}

export async function POST(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const body = Body.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });
  if (drive.owner_id !== user.id) return NextResponse.json({ error: "only owner can invite" }, { status: 403 });
  const invitee = db
    .prepare("SELECT id FROM users WHERE lower(email) = lower(?)")
    .get(body.data.email) as { id: string } | undefined;
  if (!invitee) return NextResponse.json({ error: "user not found — they must create an account first" }, { status: 404 });
  const id = nanoid(12);
  db.prepare(`
    INSERT INTO drive_members (id, drive_id, user_id, path, role)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(drive_id, user_id, path) DO UPDATE SET role = excluded.role
  `).run(id, driveId, invitee.id, body.data.path, body.data.role);
  return NextResponse.json({ ok: true });
}
