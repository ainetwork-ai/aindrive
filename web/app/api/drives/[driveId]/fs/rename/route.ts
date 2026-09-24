import { NextResponse } from "next/server";
import { z } from "zod";
import { requireDriveRole } from "@/lib/require-access";
import { AgentError, callAgent } from "@/lib/rpc";
import { bumpOwnerUsage } from "@/lib/storage-usage.js";
import { zRequiredPath } from "@/lib/zod-helpers";

const Body = z.object({ from: zRequiredPath, to: zRequiredPath });

export async function POST(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const body = Body.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const gate = await requireDriveRole(driveId, body.data.from, { min: "editor" });
  if (gate instanceof NextResponse) return gate;
  // The destination is a write too: a path-scoped editor must not move a file
  // out of (or into) a subtree they can't edit.
  const dest = await requireDriveRole(driveId, body.data.to, { min: "editor" });
  if (dest instanceof NextResponse) return dest;
  const { drive } = gate;
  const { from, to } = body.data;
  // A rename never creates a file, so it never adds to the owner's count. It
  // can remove one: the agent's rename replaces an existing FILE at `to` (a
  // folder source onto a file target fails instead), so that slot is freed.
  // A case-only rename may be the same file on a case-insensitive disk.
  let replacesFile = false;
  if (from.toLowerCase() !== to.toLowerCase()) {
    try {
      const target = await callAgent(driveId, drive.drive_secret, { method: "stat", path: to });
      replacesFile = !!target.entry && !target.entry.isDir;
    } catch { /* unknown target: count nothing */ }
  }
  try {
    const result = await callAgent(driveId, drive.drive_secret, { method: "rename", from, to });
    if (replacesFile) bumpOwnerUsage(drive.owner_id as string, { files: -1 });
    return NextResponse.json(result);
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
