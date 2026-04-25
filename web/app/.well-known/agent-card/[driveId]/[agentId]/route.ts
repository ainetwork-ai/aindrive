/**
 * GET /.well-known/agent-card/[driveId]/[agentId]
 *
 * Public A2A v1 AgentCard JSON for one agent. No auth required for
 * discovery — anyone can read the metadata. The card describes how to
 * call the agent + which auth schemes it accepts.
 *
 * This is a PROJECTION of the in-drive agent JSON — only public-safe
 * fields. NEVER include llm.apiKey, ownerId, namespacePub, etc.
 *
 * Spec: https://a2a-protocol.org/latest/specification/
 */

import { NextRequest, NextResponse } from "next/server";
import { compose } from "@/src/composition";
import { env } from "@/lib/env";
import {
  SCHEME_X402,
  SCHEME_CAP,
  type AindriveAgentCard,
} from "@/../shared/contracts/http";
import type { Agent } from "@/../shared/domain/agent/types";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ driveId: string; agentId: string }> },
) {
  const { driveId, agentId } = await params;

  const agent = await compose.agents.byId(driveId, agentId);
  if (!agent) {
    return NextResponse.json({ error: "agent_not_found" }, { status: 404 });
  }

  const card = projectAgentCard(agent, env.publicUrl.replace(/\/$/, ""));
  return NextResponse.json(card, {
    headers: {
      // Discovery endpoints should be cacheable but short-TTL so updates
      // (rename, description change) propagate quickly.
      "Cache-Control": "public, max-age=60",
    },
  });
}

function projectAgentCard(agent: Agent, baseUrl: string): AindriveAgentCard {
  const askUrl = `${baseUrl}/api/drives/${agent.driveId}/agents/${agent.id}/ask`;
  return {
    name: agent.name,
    description:
      agent.description ||
      `RAG agent over folder "${agent.folder || "/"}" of drive ${agent.driveId}.`,
    version: "1.0.0",
    supportedInterfaces: [
      {
        url: askUrl,
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0",
      },
    ],
    capabilities: { streaming: false, pushNotifications: false },
    securitySchemes: {
      [SCHEME_X402]: {
        type: "custom",
        spec: "https://github.com/google-agentic-commerce/a2a-x402",
      },
      [SCHEME_CAP]: {
        type: "http",
        scheme: "bearer",
        description:
          "Meadowcap capability obtained at /d/<driveId>/buy or via aindrive web session.",
      },
    },
    security: agent.access.policies
      .map((p) => {
        if (p === "cap-holder") return { [SCHEME_CAP]: [] };
        return null;
      })
      .filter((x): x is Record<string, string[]> => x !== null),
    skills: [
      {
        id: "ask",
        name: "Ask folder",
        description: `Q&A over the contents of "${agent.folder || "/"}".`,
        tags: ["rag", "search", "q-and-a"],
      },
    ],
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
  };
}
