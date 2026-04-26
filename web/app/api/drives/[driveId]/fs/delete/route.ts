import { NextResponse } from "next/server";
import { z } from "zod";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { resolveAccess, atLeast } from "@/lib/access";
import { AgentError, callAgent } from "@/lib/rpc";
import { bumpOwnerUsage } from "@/lib/storage-usage.js";

const Body = z.object({ path: z.string().min(1) });

export async function POST(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const body = Body.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const user = await getUser();
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });
  const role = await resolveAccess(driveId, body.data.path, user?.id ?? null);
  if (!atLeast(role, "editor")) {
    return NextResponse.json({ error: "forbidden" }, { status: user ? 403 : 401 });
  }
  // Best-effort: figure out if the path was a file or a folder before delete
  // so we can decrement the right counter. Drift on recursive folder deletes
  // is acceptable — limits are upper bounds.
  let kind: "file" | "folder" | "unknown" = "unknown";
  try {
    const slash = body.data.path.lastIndexOf("/");
    const parent = slash < 0 ? "" : body.data.path.slice(0, slash);
    const name = slash < 0 ? body.data.path : body.data.path.slice(slash + 1);
    const list = await callAgent(driveId, drive.drive_secret, { method: "list", path: parent });
    const entry = (list.entries ?? []).find((e: { name: string; isDir?: boolean }) => e.name === name);
    if (entry) kind = entry.isDir ? "folder" : "file";
  } catch { /* leave kind=unknown */ }
  try {
    const result = await callAgent(driveId, drive.drive_secret, { method: "delete", path: body.data.path });
    if (kind === "file") bumpOwnerUsage(drive.owner_id as string, { files: -1 });
    else if (kind === "folder") bumpOwnerUsage(drive.owner_id as string, { folders: -1 });
    return NextResponse.json(result);
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
