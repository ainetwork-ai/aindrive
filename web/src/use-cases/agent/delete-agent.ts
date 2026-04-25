/**
 * deleteAgent — owner-only removal of an agent.
 *
 * Idempotent at the repo level (delete of a missing file is a no-op),
 * but we still load + ownership-check first so a non-owner gets a
 * proper 403 instead of a silent 204.
 */

import type { AgentRepo } from "../../../../shared/domain/agent/ports";
import type { AgentId, DriveId, UserId } from "../../../../shared/domain/agent/types";

export type DeleteAgentDeps = { agents: AgentRepo };

export type DeleteAgentInput = {
  driveId: DriveId;
  agentId: AgentId;
  ownerId: UserId;
};

export type DeleteAgentOutput =
  | { kind: "ok" }
  | { kind: "not-found" }
  | { kind: "forbidden" };

export async function deleteAgent(
  deps: DeleteAgentDeps,
  input: DeleteAgentInput,
): Promise<DeleteAgentOutput> {
  const existing = await deps.agents.byId(input.driveId, input.agentId);
  if (!existing) return { kind: "not-found" };
  if (existing.ownerId !== input.ownerId) return { kind: "forbidden" };

  await deps.agents.delete(input.driveId, input.agentId);
  return { kind: "ok" };
}
