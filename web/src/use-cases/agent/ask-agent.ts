/**
 * askAgent — the orchestration that MUST NOT change shape as access
 * requirements evolve. New auth methods become new policies + composer
 * entries; this function stays still.
 *
 * Flow:
 *   1. Load agent. If missing → denied. If not ready → indexing.
 *   2. Identify caller via injected resolver.
 *   3. Ask injected policy whether the call is allowed.
 *   4. Map decision → output union.
 *
 * Output is a discriminated union so the HTTP adapter is a pure switch
 * with no business logic.
 *
 * See: docs/personal/haechan/AGENT_FEATURE_DESIGN.md
 */

import type {
  AccessPolicy,
  IdentityResolver,
  IdentityResolveInput,
  PaymentRequirement,
} from "../../../../shared/domain/agent/access.js";
import type {
  AgentRepo,
  RagEngine,
} from "../../../../shared/domain/agent/ports.js";
import type {
  AgentId,
  AskRequest,
  AskResult,
} from "../../../../shared/domain/agent/types.js";

export type AskAgentDeps = {
  agents: AgentRepo;
  rag: RagEngine;
  identityResolver: IdentityResolver;
  accessPolicy: AccessPolicy;
};

export type AskAgentInput = {
  agentId: AgentId;
  askRequest: AskRequest;
  http: IdentityResolveInput;
};

export type AskAgentOutput =
  | { kind: "ok"; result: AskResult; policyName: string }
  | { kind: "denied"; reason: string }
  | { kind: "indexing"; progress: number }
  | { kind: "payment-required"; requirement: PaymentRequirement }
  | { kind: "rate-limited"; retryAfterMs: number };

export async function askAgent(
  deps: AskAgentDeps,
  input: AskAgentInput,
): Promise<AskAgentOutput> {
  const agent = await deps.agents.byId(input.agentId);
  if (!agent) return { kind: "denied", reason: "agent_not_found" };

  if (agent.indexStatus !== "ready") {
    if (agent.indexStatus === "failed") {
      return { kind: "denied", reason: "agent_index_failed" };
    }
    return { kind: "indexing", progress: agent.indexProgress };
  }

  const caller = await deps.identityResolver.resolve(input.http);
  const decision = await deps.accessPolicy.decide({
    agent,
    caller,
    request: input.askRequest,
  });

  switch (decision.kind) {
    case "allow": {
      const result = await deps.rag.query(agent, input.askRequest);
      return { kind: "ok", result, policyName: deps.accessPolicy.name };
    }
    case "deny":
      return { kind: "denied", reason: decision.reason };
    case "require-payment":
      return { kind: "payment-required", requirement: decision.requirement };
    case "rate-limited":
      return { kind: "rate-limited", retryAfterMs: decision.retryAfterMs };
  }
}
