import { NextResponse } from "next/server";
import { z } from "zod";
import { requireDriveRole } from "@/lib/require-access";
import { AgentError, callAgent } from "@/lib/rpc";
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
  try {
    const result = await callAgent(driveId, drive.drive_secret, {
      method: "rename", from: body.data.from, to: body.data.to,
    });
    return NextResponse.json(result);
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
