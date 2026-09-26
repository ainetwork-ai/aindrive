import { NextResponse } from "next/server";
import { z } from "zod";
import { normalizePath } from "@/lib/path";
import { requireDriveRole } from "@/lib/require-access";
import { AgentError, callAgent } from "@/lib/rpc";
import { docIdFor } from "@/lib/dochub.js";

// The Yjs doc is named by the path the gate authorized (docIdFor, as the live
// doc hub keys it) — never by a client-sent id, which would let a grant on one
// path read or write the doc of any other, paid ones included.
const Body = z.object({
  path: z.string(),
  data: z.string(),
});

function canonicalOrNull(raw: string): string | null {
  try { return normalizePath(raw); } catch { return null; }
}

export async function POST(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const body = Body.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const path = canonicalOrNull(body.data.path);
  if (path === null) return NextResponse.json({ error: "invalid path" }, { status: 400 });
  const gate = await requireDriveRole(driveId, path, { min: "editor" });
  if (gate instanceof NextResponse) return gate;
  const { drive } = gate;
  try {
    const result = await callAgent(driveId, drive.drive_secret, {
      method: "yjs-write", docId: docIdFor(driveId, path), data: body.data.data,
    });
    return NextResponse.json(result);
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const path = canonicalOrNull(new URL(req.url).searchParams.get("path") || "");
  if (path === null) return NextResponse.json({ error: "invalid path" }, { status: 400 });
  const gate = await requireDriveRole(driveId, path, { min: "viewer" });
  if (gate instanceof NextResponse) return gate;
  const { drive } = gate;
  try {
    const result = await callAgent(driveId, drive.drive_secret, { method: "yjs-read", docId: docIdFor(driveId, path) });
    return NextResponse.json(result);
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
