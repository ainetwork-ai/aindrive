/**
 * GET /api/drives/[driveId]/agents/[agentId]/.well-known/agent-card.json
 *
 * Public A2A v1 AgentCard for one agent. The agent's "base URL" is
 *
 *   {publicUrl}/api/drives/{driveId}/agents/{agentId}
 *
 * and per RFC 8615 / A2A spec the card lives at
 *
 *   {base}/.well-known/agent-card.json
 *
 * Public projection of the in-drive agent JSON — never includes
 * llm.apiKey, ownerId, namespacePub, persona, etc.
 *
 * Spec: https://a2a-protocol.org/latest/specification/
 *       https://a2a-protocol.org/latest/topics/agent-discovery/
 */

import { NextRequest, NextResponse } from "next/server";
import { compose } from "@/src/composition";
import { env } from "@/lib/env";
import {
  SCHEME_CAP,
  type AindriveAgentCard,
} from "@/shared/contracts/http";
import type { Agent } from "@/shared/domain/agent/types";

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
      // (rename, persona change) propagate quickly.
      "Cache-Control": "public, max-age=60",
    },
  });
}

function projectAgentCard(agent: Agent, baseUrl: string): AindriveAgentCard {
  const askUrl = `${baseUrl}/api/drives/${agent.driveId}/agents/${agent.id}/ask`;
  const cardUrl = `${baseUrl}/api/drives/${agent.driveId}/agents/${agent.id}/.well-known/agent-card.json`;
  const wantsCap = agent.access.policies.includes("cap-holder");

  return {
    name: agent.name,
    description:
      agent.description ||
      `Knowledge guide for "${agent.folder || "this drive"}".`,
    version: "1.0.0",
    documentationUrl: `${baseUrl}/d/${agent.driveId}`,
    iconUrl: `${baseUrl}/icon.png`,
    provider: {
      organization: "aindrive",
      url: baseUrl,
    },
    supportedInterfaces: [
      {
        url: askUrl,
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0",
      },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
      extendedAgentCard: false,
    },
    securitySchemes: {
      [SCHEME_CAP]: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "meadowcap",
        description:
          "Meadowcap capability bound to this drive. Obtain at " +
          `${baseUrl}/d/${agent.driveId}`,
      },
    },
    security: wantsCap ? [{ [SCHEME_CAP]: [] }] : [],
    skills: [
      {
        id: "ask",
        name: `Ask ${agent.name}`,
        description: `Conversational Q&A grounded in the contents of "${agent.folder || "the drive"}".`,
        tags: ["q-and-a", "knowledge-base", "rag"],
        examples: [
          "What's the most important thing in this folder?",
          "Summarize what I should know.",
        ],
        inputModes: ["application/json", "text/plain"],
        outputModes: ["application/json", "text/plain"],
      },
    ],
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json", "text/plain"],
    // self-link so clients can verify they followed the right card URL
    url: cardUrl,
  };
}
