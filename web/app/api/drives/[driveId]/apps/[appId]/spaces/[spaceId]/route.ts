import { NextResponse } from "next/server";
import { z } from "zod";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { zPath } from "@/lib/zod-helpers";
import { setFolderShared } from "@/lib/connected-apps";

const Body = z.object({ path: zPath.default(""), shared: z.boolean() });

/** PUT { path, shared } → share this folder into (or out of) one of a connected app's spaces. Creator-only. */
export async function PUT(req: Request, { params }: { params: Promise<{ driveId: string; appId: string; spaceId: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { driveId, appId, spaceId } = await params;
  const drive = getDrive(driveId);
  if (!drive || drive.owner_id !== user.id) return NextResponse.json({ error: "only the drive creator can share it into apps" }, { status: 403 });
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const r = await setFolderShared(user.id, appId, spaceId, { driveId, path: body.data.path, shared: body.data.shared });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, shared: body.data.shared });
}
