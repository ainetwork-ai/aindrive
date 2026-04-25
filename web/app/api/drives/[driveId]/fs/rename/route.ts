import { NextResponse } from "next/server";
import { z } from "zod";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { resolveAccess, atLeast } from "@/lib/access";
import { AgentError, callAgent } from "@/lib/rpc";

const Body = z.object({ from: z.string().min(1), to: z.string().min(1) });

export async function POST(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const body = Body.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const user = await getUser();
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });
  const role = await resolveAccess(driveId, body.data.from, user?.id ?? null);
  if (!atLeast(role, "editor")) {
    return NextResponse.json({ error: "forbidden" }, { status: user ? 403 : 401 });
  }
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
