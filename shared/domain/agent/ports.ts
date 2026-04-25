/**
 * Domain ports for the Agent feature — interfaces only, no I/O.
 *
 * Concrete implementations live in `web/src/infra/...` (DB-backed
 * AgentRepo, RPC-backed RagEngine, etc). Use-cases depend only on
 * these interfaces so swapping implementations or mocking for tests
 * is trivial.
 */

import type { Agent, AgentId, AskRequest, AskResult, DriveId, NewAgentInput } from "./types.js";

export interface AgentRepo {
  byId(id: AgentId): Promise<Agent | null>;
  listByDrive(driveId: DriveId): Promise<Agent[]>;
  create(input: NewAgentInput): Promise<Agent>;
  updateIndexStatus(
    id: AgentId,
    status: Agent["indexStatus"],
    progress?: number,
  ): Promise<void>;
}

/**
 * Reads the agent's folder content somehow and answers questions over it.
 *
 * v1 implementation: forwards `query` and `index` to the CLI agent over
 * the existing WSS RPC bridge (`sendRpc(driveId, {method:"rag-query", ...})`).
 *
 * Future implementations could include a Vercel-side index for drives
 * with caps granted to the relay — same interface, different impl.
 */
export interface RagEngine {
  query(agent: Agent, request: AskRequest): Promise<AskResult>;
  /** Trigger (or re-trigger) indexing for the agent's folder. Async; status polled via AgentRepo. */
  index(agent: Agent): Promise<void>;
}
