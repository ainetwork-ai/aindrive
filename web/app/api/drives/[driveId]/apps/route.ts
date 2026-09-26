import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { zPath } from "@/lib/zod-helpers";
import { spacesForFolder } from "@/lib/connected-apps";

/**
 * GET ?path= → { apps: [{ app, spaces, error? }] } — the drive creator's
 * connected apps and whether this folder is shared into each of their spaces.
 * Creator-only: only the person whose drive it is shares it into their apps.
 */
export async function GET(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { driveId } = await params;
  const drive = getDrive(driveId);
  if (!drive || drive.owner_id !== user.id) return NextResponse.json({ apps: [] });
  const path = zPath.safeParse(new URL(req.url).searchParams.get("path") ?? "");
  if (!path.success) return NextResponse.json({ error: "invalid path" }, { status: 400 });
  return NextResponse.json({ apps: await spacesForFolder(user.id, driveId, path.data) });
}
