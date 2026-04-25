import { NextResponse } from "next/server";
import { z } from "zod";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { resolveAccess, atLeast } from "@/lib/access";
import { AgentError, callAgent } from "@/lib/rpc";

const Body = z.object({
  docId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  path: z.string(),
  data: z.string(),
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
  try {
    const result = await callAgent(driveId, drive.drive_secret, {
      method: "yjs-write", docId: body.data.docId, data: body.data.data,
    });
    return NextResponse.json(result);
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const url = new URL(req.url);
  const docId = url.searchParams.get("docId") || "";
  const path = url.searchParams.get("path") || "";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(docId)) return NextResponse.json({ error: "invalid docId" }, { status: 400 });
  const user = await getUser();
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });
  const role = await resolveAccess(driveId, path, user?.id ?? null);
  if (!atLeast(role, "viewer")) {
    return NextResponse.json({ error: "forbidden" }, { status: user ? 403 : 401 });
  }
  try {
    const result = await callAgent(driveId, drive.drive_secret, { method: "yjs-read", docId });
    return NextResponse.json(result);
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
