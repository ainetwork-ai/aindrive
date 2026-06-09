import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { listShowcase } from "@/lib/showcase";

export async function GET(_req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });
  // Relationship gate: the showcase is an upsell surface for accounts already
  // connected to this drive (owner, or at least one drive_members row at any
  // path). Unrelated logged-in users get a uniform 403 — a public storefront
  // is a non-goal.
  const related =
    drive.owner_id === user.id ||
    !!db.prepare(
      "SELECT 1 FROM drive_members WHERE drive_id = ? AND user_id = ? LIMIT 1"
    ).get(driveId, user.id);
  if (!related) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ items: listShowcase(driveId, user.id) });
}
