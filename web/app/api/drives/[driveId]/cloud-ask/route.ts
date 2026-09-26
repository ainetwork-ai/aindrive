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
 * POST { q, path, contextId?, folders? } → { answer, contextId, handed } — one turn to aindrive-cloud about
 * the open folder (lib/cloud-agent.ts), or about the @-mentioned folders instead (`folders`: other
 * drives of the caller's — lib/mention.ts). Owner only: it hands the folders' files out as links.
 */
const Body = z.object({
  q: z.string().min(1).max(2000), path: zPath.default(""), contextId: z.string().max(200).optional(),
  folders: z.array(z.object({ driveId: z.string().min(1).max(64), path: zPath.default("") })).max(5).optional(),
});

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
  const wanted = body.data.folders?.length ? body.data.folders : [{ driveId, path: body.data.path }];
  const folders: { driveId: string; driveSecret: string; folder: string }[] = [];
  for (const w of wanted) {
    const d = w.driveId === driveId ? drive : getDrive(w.driveId);
    if (!d || d.owner_id !== user.id)
      return NextResponse.json({ error: "Only the drive's owner can hand its files to aindrive-cloud" }, { status: 403 });
    if (!isOnline(d.id))
      return NextResponse.json({ error: `${d.name}'s device is offline, so aindrive-cloud can't see its files` }, { status: 503 });
    folders.push({ driveId: d.id, driveSecret: d.drive_secret, folder: w.path });
  }
  try {
    const r = await askCloud({ ownerId: user.id, folders, q: body.data.q, contextId: body.data.contextId });
    return NextResponse.json({ answer: r.text, contextId: r.contextId ?? null, handed: r.handed });
  } catch (e) {
    const status = e instanceof AgentError ? e.status : 502;
    return NextResponse.json({ error: `aindrive-cloud: ${(e as Error).message}` }, { status });
  }
}
