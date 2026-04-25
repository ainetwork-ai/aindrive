import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { resolveAccess, atLeast } from "@/lib/access";
import { AgentError, callAgent } from "@/lib/rpc";

export async function GET(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  const encoding = (url.searchParams.get("encoding") === "base64" ? "base64" : "utf8") as "utf8" | "base64";
  if (!path) return NextResponse.json({ error: "path required" }, { status: 400 });
  const user = await getUser();
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });
  const role = await resolveAccess(driveId, path, user?.id ?? null);
  if (!atLeast(role, "viewer")) {
    return NextResponse.json({ error: "forbidden" }, { status: user ? 403 : 401 });
  }
  try {
    const result = await callAgent(driveId, drive.drive_secret, { method: "read", path, encoding });
    return NextResponse.json(result);
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
