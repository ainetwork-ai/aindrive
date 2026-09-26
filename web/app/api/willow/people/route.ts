import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { db } from "@/lib/db.js";
import { getDrive } from "@/lib/drives";

/**
 * GET /api/willow/people?drive=<id> → { people: { [userId]: name } } for the owner
 * and members of the drive: what "who wrote this" shows next to a signed edit.
 * Any member (any role, any path) may ask; nothing but names is returned.
 */
export async function GET(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "sign in" }, { status: 401 });
  const driveId = new URL(req.url).searchParams.get("drive") ?? "";
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "not found" }, { status: 404 });
  const member = drive.owner_id === user.id || !!db.prepare("SELECT 1 FROM drive_members WHERE drive_id = ? AND user_id = ? LIMIT 1").get(driveId, user.id);
  if (!member) return NextResponse.json({ error: "not found" }, { status: 404 });
  const rows = db.prepare(`
    SELECT u.id, u.name FROM users u WHERE u.id = ?
    UNION SELECT u.id, u.name FROM drive_members m JOIN users u ON u.id = m.user_id WHERE m.drive_id = ?
  `).all(drive.owner_id, driveId) as { id: string; name: string | null }[];
  return NextResponse.json({ people: Object.fromEntries(rows.map((r) => [r.id, r.name ?? "someone"])) });
}
