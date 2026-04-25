import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { getDrive, rotateAgentToken } from "@/lib/drives";

export async function POST(_req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = await getDrive(driveId);
  if (!drive || drive.owner_id !== user.id) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { agentToken, driveSecret } = await rotateAgentToken(driveId);
  return NextResponse.json({ agentToken, driveSecret });
}
