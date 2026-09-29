import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { isRelatedToDrive } from "@/lib/access";
import { listShowcase } from "@/lib/showcase";

export async function GET(_req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });
  // Relationship gate: the showcase is an upsell surface for accounts already
  // connected to this drive (isRelatedToDrive: owner, at least one
  // drive_members row at any path, or an organization the drive is shared
  // with). Unrelated logged-in users get a uniform 403 — a public storefront
  // is a non-goal. showcase/[shareId] uses the same gate.
  if (!isRelatedToDrive(driveId, user.id)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ items: listShowcase(driveId, user.id) });
}
