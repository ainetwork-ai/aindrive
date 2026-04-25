/**
 * AgentExecutor implementation that forwards execution to the CLI agent
 * over the existing WSS RPC bridge. The CLI loads the agent JSON from
 * its local disk, runs KB + LLM, and returns the answer.
 *
 * This is the trust boundary: web has already verified caller identity
 * and access policy. We pass the bare (driveId, agentId, query) — no
 * caller info, no auth token, because the WSS link itself is HMAC-
 * authenticated and policy is already enforced upstream.
 */

import { sendRpc } from "../../../lib/agents";
import type { AgentExecutor } from "@/shared/domain/agent/ports";
import type { AskResult } from "@/shared/domain/agent/types";

export const rpcAgentExecutor: AgentExecutor = {
  async ask({ driveId, agentId, request }): Promise<AskResult> {
    const r = await sendRpc(
      driveId,
      { method: "agent-ask", agentId, query: request.q },
      // CLI does folder walk + LLM call; allow more than the default
      // 25s for slow models.
      { timeoutMs: 60_000 },
    );
    return { answer: r.answer, sources: r.sources };
  },
};
