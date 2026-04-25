import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";

export async function DELETE(_req: Request, { params }: { params: Promise<{ driveId: string; id: string }> }) {
  const { driveId, id } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = getDrive(driveId);
  if (!drive || drive.owner_id !== user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const result = db.prepare("DELETE FROM folder_access WHERE id = ? AND drive_id = ?").run(id, driveId);
  if (result.changes === 0) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
