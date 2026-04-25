/**
 * /api/drives/[driveId]/agents/[agentId]
 *
 *   PATCH  → owner-only edit. Body shape mirrors the create body but
 *            every top-level field is optional. Returns the updated
 *            agent (apiKey stripped via toPublicAgent).
 *   DELETE → owner-only removal. 204 on success, 403/404 otherwise.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { compose } from "@/src/composition";
import { updateAgent } from "@/src/use-cases/agent/update-agent";
import { deleteAgent } from "@/src/use-cases/agent/delete-agent";
import type { Agent } from "@/shared/domain/agent/types";

const Patch = z.object({
  name: z.string().max(80).optional(),
  description: z.string().max(500).optional(),
  persona: z.string().max(1500).optional(),
  folder: z.string().max(1024).optional(),
  knowledge: z.object({ strategy: z.string() }).optional(),
  llm: z.object({
    provider: z.string().optional(),
    model: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().max(4096).optional(),
    apiKey: z.string().optional(),
  }).optional(),
  access: z.object({ policies: z.array(z.string()).min(1) }).optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ driveId: string; agentId: string }> },
) {
  const { driveId, agentId } = await params;

  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive_not_found" }, { status: 404 });
  if (drive.owner_id !== user.id) {
    return NextResponse.json({ error: "not_owner" }, { status: 403 });
  }

  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request", issues: parsed.error.issues }, { status: 400 });
  }

  const out = await updateAgent(compose.updateAgent, {
    driveId,
    agentId,
    ownerId: user.id,
    patch: parsed.data,
  });

  switch (out.kind) {
    case "ok":        return NextResponse.json({ ok: true, agent: toPublicAgent(out.agent) });
    case "not-found": return NextResponse.json({ error: "agent_not_found" }, { status: 404 });
    case "forbidden": return NextResponse.json({ error: "not_owner" }, { status: 403 });
    case "rejected":  return NextResponse.json({ error: out.reason }, { status: 400 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ driveId: string; agentId: string }> },
) {
  const { driveId, agentId } = await params;

  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive_not_found" }, { status: 404 });
  if (drive.owner_id !== user.id) {
    return NextResponse.json({ error: "not_owner" }, { status: 403 });
  }

  const out = await deleteAgent(compose.deleteAgent, {
    driveId,
    agentId,
    ownerId: user.id,
  });

  switch (out.kind) {
    case "ok":        return new NextResponse(null, { status: 204 });
    case "not-found": return NextResponse.json({ error: "agent_not_found" }, { status: 404 });
    case "forbidden": return NextResponse.json({ error: "not_owner" }, { status: 403 });
  }
}

function toPublicAgent(agent: Agent) {
  return {
    id: agent.id,
    driveId: agent.driveId,
    ownerId: agent.ownerId,
    folder: agent.folder,
    name: agent.name,
    description: agent.description,
    persona: agent.persona,
    knowledge: agent.knowledge,
    llm: { provider: agent.llm.provider, model: agent.llm.model },
    access: agent.access,
    createdAt: agent.createdAt,
  };
}
