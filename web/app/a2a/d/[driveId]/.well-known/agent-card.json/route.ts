/**
 * GET /a2a/d/[driveId]/.well-known/agent-card.json — the AgentCard of a drive's on-device agent
 * (lib/device-agent-a2a.ts). Only for someone the drive's bearer admits: a card names the drive
 * and the device it lives on.
 */
import { NextResponse } from "next/server";
import { resolveAgentAuth } from "@/lib/agent-auth";
import { deviceAgentCard } from "@/lib/device-agent-a2a";
import { getDrive } from "@/lib/drives";
import { env } from "@/lib/env";

export async function GET(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });
  const auth = await resolveAgentAuth(req, driveId);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json(deviceAgentCard(env.publicUrl, { id: drive.id, name: drive.name, hostname: drive.last_hostname }));
}
