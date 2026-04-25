/**
 * askAgent — orchestrates one ask against an agent.
 *
 * Web side responsibility (this function):
 *   1. Load agent metadata via AgentRepo.
 *   2. Identify caller via injected IdentityResolver.
 *   3. Ask injected AccessPolicy whether to allow.
 *   4. If allowed, forward execution to the CLI via AgentExecutor —
 *      the agent's KnowledgeBase + LlmClient run on the owner's machine,
 *      so the API key (agent.llm.apiKey) never crosses to web.
 *
 * Output is a discriminated union; HTTP adapter is a pure switch
 * over `kind`.
 */

import type {
  IdentityResolveInput,
  IdentityResolver,
  PaymentRequirement,
} from "@/shared/domain/agent/access";
import type {
  AccessPolicyFactory,
  AgentExecutor,
  AgentRepo,
} from "@/shared/domain/agent/ports";
import type {
  AgentId,
  AskRequest,
  AskResult,
  DriveId,
} from "@/shared/domain/agent/types";

export type AskAgentDeps = {
  agents: AgentRepo;
  identityResolver: IdentityResolver;
  /**
   * Per-agent policy resolution. Each agent's stored `access` config
   * drives which combination of policies decides the call. The factory
   * itself is one shared instance; it dispatches by config key.
   */
  policyFactory: AccessPolicyFactory;
  /** Forwards allowed asks to the CLI agent on the owner's machine. */
  executor: AgentExecutor;
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

  // Resolve the policy from agent.access; unknown policy name → hard
  // deny so the route returns 4xx rather than crashing.
  let policy;
  try {
    policy = deps.policyFactory.make(agent.access);
  } catch (e) {
    return { kind: "denied", reason: `agent_misconfigured:${(e as Error).message}` };
  }

  const caller = await deps.identityResolver.resolve(input.http);
  const decision = await policy.decide({
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

  // Trust boundary crossed: web has authorized this call. Forward to
  // the CLI which runs KB + LLM with the local agent.json (apiKey
  // included). Web never sees the apiKey for this request.
  let result: AskResult;
  try {
    result = await deps.executor.ask({
      driveId: input.driveId,
      agentId: input.agentId,
      request: input.askRequest,
    });
  } catch (e) {
    return { kind: "denied", reason: `agent_execution_failed:${(e as Error).message}` };
  }

  return { kind: "ok", result, policyName: policy.name };
}
