/**
 * askAgent — orchestrates one ask against an agent.
 *
 * Pipeline (deliberately small, will not change as features grow):
 *   1. Load agent.
 *   2. Identify caller via injected resolver.
 *   3. Ask injected policy whether to allow.
 *   4. If allowed, fetch knowledge from injected KnowledgeBase
 *      (v1: dumps all text files; future: real RAG).
 *   5. Build system prompt from chunks.
 *   6. Generate answer via injected LlmClient.
 *   7. Map chunks → sources for the response.
 *
 * Output is a discriminated union; HTTP adapter is a pure switch
 * over `kind`.
 */

import type {
  AccessPolicy,
  IdentityResolveInput,
  IdentityResolver,
  PaymentRequirement,
} from "../../../../shared/domain/agent/access.js";
import type {
  AgentRepo,
  KnowledgeBase,
  KnowledgeChunk,
  LlmClient,
} from "../../../../shared/domain/agent/ports.js";
import type {
  AgentId,
  AskRequest,
  AskResult,
  DriveId,
} from "../../../../shared/domain/agent/types.js";

export type AskAgentDeps = {
  agents: AgentRepo;
  identityResolver: IdentityResolver;
  accessPolicy: AccessPolicy;
  knowledgeBase: KnowledgeBase;
  llm: LlmClient;
};

export type AskAgentInput = {
  driveId: DriveId;
  agentId: AgentId;
  askRequest: AskRequest;
  http: IdentityResolveInput;
};

export type AskAgentOutput =
  | { kind: "ok"; result: AskResult; policyName: string }
  | { kind: "denied"; reason: string }
  | { kind: "payment-required"; requirement: PaymentRequirement }
  | { kind: "rate-limited"; retryAfterMs: number };

export async function askAgent(
  deps: AskAgentDeps,
  input: AskAgentInput,
): Promise<AskAgentOutput> {
  const agent = await deps.agents.byId(input.driveId, input.agentId);
  if (!agent) return { kind: "denied", reason: "agent_not_found" };

  const caller = await deps.identityResolver.resolve(input.http);
  const decision = await deps.accessPolicy.decide({
    agent,
    caller,
    request: input.askRequest,
  });

  switch (decision.kind) {
    case "deny":            return { kind: "denied", reason: decision.reason };
    case "require-payment": return { kind: "payment-required", requirement: decision.requirement };
    case "rate-limited":    return { kind: "rate-limited", retryAfterMs: decision.retryAfterMs };
    case "allow":
      // fall through
      break;
  }

  const chunks = await deps.knowledgeBase.fetch({
    agent,
    query: input.askRequest.q,
  });

  const answer = await deps.llm.complete({
    system: buildSystemPrompt(chunks, agent.name),
    user: input.askRequest.q,
  });

  return {
    kind: "ok",
    result: {
      answer,
      sources: chunks.map(toSource),
    },
    policyName: deps.accessPolicy.name,
  };
}

// ─── Prompt + source mapping (small enough to live inline) ─────────────────

function buildSystemPrompt(chunks: ReadonlyArray<KnowledgeChunk>, agentName: string): string {
  const knowledge = chunks.length === 0
    ? "(no knowledge available — the folder is empty or contains no readable text files)"
    : chunks.map(c => `── ${c.path} ──\n${c.text}`).join("\n\n");
  return [
    `You are "${agentName}", an AI assistant answering questions strictly from the documents below.`,
    `Rules:`,
    `  - Answer ONLY using the documents. Do not invent facts.`,
    `  - If the answer is not in the documents, reply exactly: "I don't see that in this folder."`,
    `  - Cite source files in parentheses, e.g. "(see docs/q1-okr.md)".`,
    `  - Keep answers concise.`,
    ``,
    `DOCUMENTS:`,
    knowledge,
  ].join("\n");
}

function toSource(chunk: KnowledgeChunk) {
  return {
    path: chunk.path,
    lineStart: chunk.lineStart ?? 1,
    lineEnd: chunk.lineEnd ?? 1,
    snippet: chunk.text.length > 280 ? chunk.text.slice(0, 280) + "…" : chunk.text,
  };
}
