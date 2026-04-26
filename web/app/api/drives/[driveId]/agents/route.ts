/**
 * /api/drives/[driveId]/agents — owner CRUD over agents in a drive.
 *
 *   POST → create new agent (owner only). Body: { folder, name, description,
 *          knowledge, llm, access }. Returns { ok, agent } (apiKey stripped).
 *   GET  → list agents in this drive (owner only).
 *
 * Routes are thin: parse body → auth → load drive → call use-case → format.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getUser } from "@/lib/session";
import { getDrive, getDriveNamespace } from "@/lib/drives";
import { compose } from "@/src/composition";
import { createAgent } from "@/src/use-cases/agent/create-agent";
import type { Agent } from "@/shared/domain/agent/types";
import { HARD_MAX_AGENTS_PER_DRIVE } from "@/lib/tier";

const Body = z.object({
  folder: z.string().max(1024).default(""),
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(""),
  persona: z.string().max(1500).default(""),
  knowledge: z.object({ strategy: z.string() }).default({ strategy: "dump-all-text" }),
  llm: z.object({
    provider: z.string(),
    model: z.string(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().max(4096).optional(),
    apiKey: z.string().optional(),
  }),
  access: z.object({ policies: z.array(z.string()).min(1) }).default({
    policies: ["owner", "cap-holder"],
  }),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ driveId: string }> },
) {
  const { driveId } = await params;

  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive_not_found" }, { status: 404 });
  if (drive.owner_id !== user.id) {
    return NextResponse.json({ error: "not_owner" }, { status: 403 });
  }

  const ns = getDriveNamespace(driveId);
  if (!ns) {
    return NextResponse.json({ error: "drive_namespace_missing" }, { status: 500 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request", issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;

  // Hard anti-abuse cap (NOT a billing dimension — usage is metered on /ask).
  const existing = await compose.agents.listByDrive(driveId);
  if (existing.length >= HARD_MAX_AGENTS_PER_DRIVE) {
    return NextResponse.json(
      { error: "agent_count_limit", limit: HARD_MAX_AGENTS_PER_DRIVE, current: existing.length },
      { status: 429 },
    );
  }

  const out = await createAgent(compose.createAgent, {
    driveId,
    ownerId: user.id,
    namespacePub: ns.pub,
    folder: body.folder,
    name: body.name,
    description: body.description,
    persona: body.persona,
    knowledge: body.knowledge,
    llm: body.llm,
    access: body.access,
  });

  if (out.kind === "rejected") {
    return NextResponse.json({ error: out.reason }, { status: 400 });
  }

  return NextResponse.json({ ok: true, agent: toPublicAgent(out.agent) });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ driveId: string }> },
) {
  const { driveId } = await params;

  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive_not_found" }, { status: 404 });
  if (drive.owner_id !== user.id) {
    return NextResponse.json({ error: "not_owner" }, { status: 403 });
  }

  const agents = await compose.agents.listByDrive(driveId);
  return NextResponse.json({ agents: agents.map(toPublicAgent) });
}

/**
 * Strip secrets and binary metadata before sending to the browser.
 * llm.apiKey, namespacePub MUST never round-trip through the public API.
 */
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
