import { NextResponse } from "next/server";
import { AgentError, callAgent } from "@/lib/rpc";
import { normalizePath } from "@/lib/path";
import { requireDriveRole } from "@/lib/require-access";

export async function GET(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const url = new URL(req.url);
  let path: string;
  try { path = normalizePath(url.searchParams.get("path") || ""); }
  catch { return NextResponse.json({ error: "invalid path" }, { status: 400 }); }
  const gate = await requireDriveRole(driveId, path, { min: "viewer" });
  if (gate instanceof NextResponse) return gate;
  const { drive, role } = gate;
  try {
    const result = await callAgent(driveId, drive.drive_secret, { method: "list", path });
    return NextResponse.json({ entries: result.entries, role });
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
