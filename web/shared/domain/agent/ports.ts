/**
 * Domain ports for the Agent feature (web side).
 *
 * v1 architecture splits responsibility between web and CLI:
 *
 *   web side  — identity, access policy, agent metadata CRUD, A2A card
 *               publication. Holds NO secrets.
 *   CLI side  — actual agent execution: KnowledgeBase + LlmClient run
 *               on the owner's machine. The API key never crosses to web.
 *
 * So this file declares ports for the WEB side only:
 *   - AgentRepo      CRUD of agent JSON files (via FsBrowser)
 *   - FsBrowser      thin RPC wrapper for list/read/write
 *   - AgentExecutor  forwards "run this agent with this query" to the CLI
 *   - AccessPolicyFactory  composes named policies for an agent
 *
 * KnowledgeBase / LlmClient (and their factories) live in cli/src/
 * because they only run there.
 */

import type {
  AccessConfig,
  Agent,
  AgentId,
  AskRequest,
  AskResult,
  DriveId,
  NewAgentInput,
} from "./types.js";
import type { AccessPolicy } from "./access.js";

// ─── Persistence ───────────────────────────────────────────────────────────

/**
 * Where agent metadata lives. v1 stores each agent as a JSON file inside
 * the drive itself at <drive>/.aindrive/agents/<id>.json — no separate DB.
 *
 * `byId` takes driveId because each impl scopes by drive (the file lives
 * inside that drive's tree). HTTP routes always carry driveId in the URL.
 */
export interface AgentRepo {
  byId(driveId: DriveId, id: AgentId): Promise<Agent | null>;
  listByDrive(driveId: DriveId): Promise<Agent[]>;
  create(input: NewAgentInput): Promise<Agent>;
  /**
   * Replace the stored agent with `next`. The id/driveId/ownerId/createdAt
   * fields of `next` MUST match the existing entry — repo doesn't validate
   * that, the use-case does. Returns the saved entry.
   */
  update(next: Agent): Promise<Agent>;
  /** No-op if the agent doesn't exist. */
  delete(driveId: DriveId, id: AgentId): Promise<void>;
}

// ─── FS browser: thin port for AgentRepo ───────────────────────────────────

export type FileEntry = {
  path: string;       // drive-relative
  isDir: boolean;
  size: number;
  ext: string;
};

/**
 * Minimal filesystem port. v1 consumer is FsAgentRepo (read/write agent
 * metadata under .aindrive/agents/). Concrete impl forwards to the
 * existing CLI agent over WSS RPC.
 *
 * Server-internal callers bypass the cap-bearer .aindrive/ block — that
 * block lives at the HTTP middleware layer, not here.
 */
export interface FsBrowser {
  list(driveId: DriveId, path: string): Promise<FileEntry[]>;
  read(driveId: DriveId, path: string, maxBytes?: number): Promise<string>;
  write(driveId: DriveId, path: string, content: string): Promise<void>;
  delete(driveId: DriveId, path: string): Promise<void>;
}

// ─── AgentExecutor: forward ask to the CLI for actual execution ────────────

/**
 * Runs an agent's ask end-to-end on the owner's machine. The web side
 * has already verified caller identity + access policy by the time
 * this is called.
 *
 * v1 impl: RpcAgentExecutor — sends an `agent-ask` RPC to the CLI which
 * loads the agent JSON locally, runs the configured KnowledgeBase, and
 * calls the configured LlmClient. The API key (in agent.llm.apiKey)
 * never crosses to web.
 */
export interface AgentExecutor {
  ask(input: {
    driveId: DriveId;
    agentId: AgentId;
    request: AskRequest;
  }): Promise<AskResult>;
}

// ─── AccessPolicyFactory ───────────────────────────────────────────────────

/**
 * Builds a composed AccessPolicy from a per-agent AccessConfig.
 * Throws if any policy name in `config.policies` is unknown.
 *
 * v1 supports: "owner", "cap-holder".
 * Adding "x402-payer" / "subscriber" / … = register a new policy with
 * the factory implementation; this interface stays unchanged.
 */
export interface AccessPolicyFactory {
  make(config: AccessConfig): AccessPolicy;
}
