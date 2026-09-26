import { NextResponse } from "next/server";
import { z } from "zod";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { isOnline, AgentError } from "@/lib/rpc";
import { zPath } from "@/lib/zod-helpers";
import { tryConsume, clientKey } from "@/lib/rate-limit";
import { askCloud, CLOUD_AGENT } from "@/lib/cloud-agent";

/**
 * GET  → { agent } — aindrive-cloud as Folder Chat shows it.
 * POST { q, path, contextId? } → { answer, contextId, handed } — one turn to aindrive-cloud about
 * the open folder (lib/cloud-agent.ts). Owner only: it hands the folder's files out as links.
 */
const Body = z.object({ q: z.string().min(1).max(2000), path: zPath.default(""), contextId: z.string().max(200).optional() });

export async function GET() {
  return NextResponse.json({ agent: { name: CLOUD_AGENT.name, by: CLOUD_AGENT.by, model: CLOUD_AGENT.model } });
}

export async function POST(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { driveId } = await params;
  const drive = getDrive(driveId);
  if (!drive || drive.owner_id !== user.id)
    return NextResponse.json({ error: "Only the drive's owner can hand its files to aindrive-cloud" }, { status: 403 });
  const rl = tryConsume({ name: "cloud-ask", key: clientKey(req, `cloud-ask:${user.id}`), limit: 10, windowMs: 60_000 });
  if (!rl.ok) return NextResponse.json({ error: "rate_limited", retryAfterMs: rl.retryAfterMs }, { status: 429 });
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  if (!isOnline(driveId)) return NextResponse.json({ error: "This drive's device is offline, so aindrive-cloud can't see its files" }, { status: 503 });
  try {
    const r = await askCloud({ ownerId: user.id, driveId, driveSecret: drive.drive_secret, folder: body.data.path, q: body.data.q, contextId: body.data.contextId });
    return NextResponse.json({ answer: r.text, contextId: r.contextId ?? null, handed: r.handed });
  } catch (e) {
    const status = e instanceof AgentError ? e.status : 502;
    return NextResponse.json({ error: `aindrive-cloud: ${(e as Error).message}` }, { status });
  }
}
