import { NextResponse } from "next/server";
import { z } from "zod";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { resolveAccess, atLeast } from "@/lib/access";
import { AgentError, callAgent } from "@/lib/rpc";

const MAX_WRITE_BYTES = parseInt(process.env.AINDRIVE_MAX_WRITE_BYTES ?? String(16 * 1024 * 1024), 10);

const Body = z.object({
  path: z.string().min(1),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).optional(),
});

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
  const { content, encoding } = body.data;
  const byteLength = encoding === "base64"
    ? Math.ceil(content.length * 3 / 4)
    : Buffer.byteLength(content, "utf8");
  if (byteLength > MAX_WRITE_BYTES) {
    return NextResponse.json(
      { error: "payload too large", limit: MAX_WRITE_BYTES },
      { status: 413, headers: { "X-Max-Bytes": String(MAX_WRITE_BYTES) } },
    );
  }
  try {
    const result = await callAgent(driveId, drive.drive_secret, {
      method: "write", path: body.data.path, content, encoding: body.data.encoding,
    });
    return NextResponse.json(result);
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
