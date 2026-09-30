/**
 * POST /api/drives/:driveId/rotate — new agent token + drive secret (creator
 * only). Every device connected with the old pair is disconnected (4401) and
 * refused on reconnect: this is how the web removes a lost device from a drive
 * while keeping the drive, its members and links. The response carries the new
 * pair for the caller (the CLI's `aindrive rotate-token` writes it to the
 * folder's .aindrive/config.json); the web's "Remove device" discards it.
 */
import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { getDrive, rotateAgentToken } from "@/lib/drives";
import { disconnectAgent } from "@/lib/agents.js";

export async function POST(_req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = await getDrive(driveId);
  if (!drive || drive.owner_id !== user.id) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { agentToken, driveSecret } = await rotateAgentToken(driveId);
  // The old pair is dead: drop every device still connected with it (a lost
  // device must not keep serving on its open socket). A device that rotated
  // itself (`aindrive rotate-token`) is restarted with the new pair anyway.
  disconnectAgent(driveId, 4401, "credentials rotated");
  return NextResponse.json({ agentToken, driveSecret });
}
