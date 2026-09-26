import { NextResponse } from "next/server";
import { z } from "zod";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { isOnline, AgentError } from "@/lib/rpc";
import { zPath } from "@/lib/zod-helpers";
import { tryConsume, clientKey } from "@/lib/rate-limit";
import { handFolder } from "@/lib/cloud-agent";

/**
 * POST { path, audience } → { context, deviceSays, entries, truncated, links: [{ id, url, name, mime, expiresAt }], mcp }
 *
 * A folder of this drive handed to an A2A agent — for the phone's "@agent @folder-in-device …" when the
 * folder lives on another device, so the phone cannot list it itself (mobile/src/main.ts). The same
 * handoff aindrive-cloud turns get (lib/cloud-agent.ts handFolder): the listing, and the newest files as
 * 15-minute links + an MCP view over exactly those. Owner only: it hands the folder's files out.
 */
const Body = z.object({ path: zPath.default(""), audience: z.string().min(1).max(300) });

export async function POST(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { driveId } = await params;
  const drive = getDrive(driveId);
  if (!drive || drive.owner_id !== user.id)
    return NextResponse.json({ error: "Only the drive's owner can hand its files to an agent" }, { status: 403 });
  const rl = tryConsume({ name: "folder-handoff", key: clientKey(req, `folder-handoff:${user.id}`), limit: 20, windowMs: 60_000 });
  if (!rl.ok) return NextResponse.json({ error: "rate_limited", retryAfterMs: rl.retryAfterMs }, { status: 429 });
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  if (!isOnline(driveId)) return NextResponse.json({ error: "This drive's device is offline, so its files can't be handed over" }, { status: 503 });
  try {
    const r = await handFolder({ ownerId: user.id, driveId, driveSecret: drive.drive_secret, folder: body.data.path, audience: body.data.audience });
    return NextResponse.json({
      context: r.context,
      deviceSays: r.deviceSays,
      truncated: r.truncated,
      entries: r.entries.map((e) => ({ name: e.name, path: e.rel, isDir: e.isDir, size: e.size, mime: e.mime })),
      links: r.links,
      mcp: r.mcp,
    });
  } catch (e) {
    const status = e instanceof AgentError ? e.status : 502;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
