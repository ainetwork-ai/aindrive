import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { agentMaterializes } from "@/lib/agents.js";
import { isMember } from "@/lib/willow/roles";

/** GET /api/willow/agent?drive=<id> → { materializes }: does the drive's agent write
 *  documents into their files itself? Then browsers stop saving files. */
export async function GET(req: Request) {
  const user = await getUser();
  const driveId = new URL(req.url).searchParams.get("drive") ?? "";
  if (!user || !isMember(driveId, user.id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ materializes: agentMaterializes(driveId) });
}
