import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getRequestUser } from '@/lib/session';
import { getDrive } from '@/lib/drives';
import { isOnline } from '@/lib/rpc';
import { zPath } from '@/lib/zod-helpers';
import { tryConsume, clientKey } from '@/lib/rate-limit';
import { askCloud, CLOUD_AGENT } from '@/lib/cloud-agent';
import { folderChatStream } from '@/lib/folder-chat-stream';

// Server-owned remote-agent catalog: browsers cannot choose arbitrary server fetch URLs.
const Agent = z.object({ id: z.string().regex(/^[a-z0-9_-]+$/), label: z.string().min(1), card: z.string().url() });
function agents() {
  const configured = z.array(Agent).parse(JSON.parse(process.env.AINDRIVE_FOLDER_AGENTS || '[]'));
  return [{ id: 'cloud', label: CLOUD_AGENT.name, card: CLOUD_AGENT.card }, ...configured.filter(a => a.id !== 'cloud')];
}
async function owner(req: Request, driveId: string) {
  const user = await getRequestUser(req);
  if (!user || user === 'invalid') return null;
  const drive = getDrive(driveId);
  return drive?.owner_id === user.id ? { user, drive } : null;
}
export async function GET(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  if (!await owner(req, (await params).driveId)) return NextResponse.json({ error: 'Folder chat requires the connected drive owner' }, { status: 403 });
  return NextResponse.json({ agents: agents().map(({ id, label }) => ({ id, label, remote: true })) });
}
const Body = z.object({ q: z.string().trim().min(1).max(2000), path: zPath.default(''), agentId: z.string().default('cloud'), contextId: z.string().max(200).optional() });
export async function POST(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const identity = await owner(req, driveId);
  if (!identity) return NextResponse.json({ error: 'Folder chat requires the connected drive owner' }, { status: 403 });
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'Invalid folder chat request' }, { status: 400 });
  const agent = agents().find(a => a.id === body.data.agentId);
  if (!agent) return NextResponse.json({ error: 'Unknown remote agent' }, { status: 400 });
  const rl = tryConsume({ name: 'cloud-ask', key: clientKey(req, `cloud-ask:${identity.user.id}`), limit: 10, windowMs: 60000 });
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  if (!isOnline(driveId)) return NextResponse.json({ error: 'The folder device is offline' }, { status: 503 });
  return folderChatStream(req, { driveId, path: body.data.path, agent, q: body.data.q }, async (signal, onUpdate) => askCloud({ ownerId: identity.user.id, driveId, driveSecret: identity.drive.drive_secret, folder: body.data.path, q: body.data.q, contextId: body.data.contextId, cardUrl: agent.card, signal, onUpdate }));
}
