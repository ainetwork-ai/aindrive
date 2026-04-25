import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { resolveAccess, atLeast } from "@/lib/access";
import { AgentError, callAgent } from "@/lib/rpc";

const MAX_READ_BYTES = parseInt(process.env.AINDRIVE_MAX_READ_BYTES ?? String(16 * 1024 * 1024), 10);

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
    if (result && typeof result.content === "string") {
      const byteLength = encoding === "base64"
        ? Math.ceil(result.content.length * 3 / 4)
        : Buffer.byteLength(result.content, "utf8");
      if (byteLength > MAX_READ_BYTES) {
        return NextResponse.json(
          { error: "file too large to stream", limit: MAX_READ_BYTES, size: byteLength },
          { status: 413 },
        );
      }
    }
    return NextResponse.json(result);
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
