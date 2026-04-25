/**
 * Domain ports for the Agent feature.
 *
 * Two axes of future change are isolated behind ports:
 *   1. KnowledgeBase — HOW we produce relevant context for a query.
 *      v1: dump all .txt/.md content of the agent's folder (no retrieval).
 *      Future: vector RAG, BM25, hybrid, summarization, query rewriting…
 *      Swapping the strategy = swap one composition wire. askAgent unchanged.
 *
 *   2. LlmClient — WHICH model does the actual generation.
 *      v1: OpenAI gpt-4o-mini.
 *      Future: Anthropic, local llama.cpp, Vercel AI Gateway routing, …
 *
 * Plus a small file-browsing port that v1 KnowledgeBase impls use to
 * read the drive's files via the existing CLI agent RPC bridge.
 */

import type {
  AccessConfig,
  Agent,
  AgentId,
  DriveId,
  KnowledgeConfig,
  LlmConfig,
  NewAgentInput,
} from "./types.js";
import type { AccessPolicy } from "./access.js";

// ─── Persistence ───────────────────────────────────────────────────────────

/**
 * Where agent metadata lives. v1 stores each agent as a JSON file inside
 * the drive itself at <drive>/.aindrive/agents/<id>.json — no separate DB,
 * no migration, agent travels with the drive on export/sync.
 *
 * Future impls (e.g. Willow-backed, Postgres-backed) implement the same
 * interface; consumers only see the port.
 *
 * `byId` takes driveId because each impl scopes by drive (the file lives
 * inside that drive's tree). HTTP routes always carry driveId in the URL.
 */
export interface AgentRepo {
  byId(driveId: DriveId, id: AgentId): Promise<Agent | null>;
  listByDrive(driveId: DriveId): Promise<Agent[]>;
  create(input: NewAgentInput): Promise<Agent>;
}

// ─── KnowledgeBase: where context comes from ───────────────────────────────

/**
 * A single piece of knowledge handed to the LLM.
 *
 * v1 may produce one big chunk per file (whole file as text); future
 * impls may produce many smaller chunks with line ranges and scores.
 * The shape is forward-compatible — extra optional fields can be added
 * without breaking consumers.
 */
export type KnowledgeChunk = {
  path: string;          // drive-relative file path
  lineStart?: number;    // optional; v1 omits, citation falls back to whole file
  lineEnd?: number;
  text: string;
  /** 0..1 relevance — populated by retrieval impls; v1 leaves undefined. */
  score?: number;
};

export interface KnowledgeBase {
  /**
   * Produce knowledge chunks relevant to `query` from the agent's folder.
   *
   * Implementations decide the strategy entirely:
   *   - DumpAllTextKb: ignore `query`, return every .txt/.md file as one chunk each
   *   - VectorRagKb (future): embed query, return top-k chunks
   *   - HybridKb (future): combine
   */
  fetch(input: { agent: Agent; query: string; maxChunks?: number }): Promise<KnowledgeChunk[]>;
}

// ─── LLM: how the answer is generated ──────────────────────────────────────

export interface LlmClient {
  complete(input: {
    system: string;
    user: string;
    /** Soft cap on output tokens; impls may clamp further. */
    maxTokens?: number;
  }): Promise<string>;
}

// ─── FS browser: thin port the v1 KnowledgeBase uses to read drive files ───

export type FileEntry = {
  path: string;       // drive-relative
  isDir: boolean;
  size: number;
  ext: string;
};

/**
 * Minimal filesystem port. Two consumers:
 *   - KnowledgeBase impls (read drive content as knowledge)
 *   - FsAgentRepo (read/write agent metadata under .aindrive/agents/)
 *
 * Concrete impl in v1 forwards to the existing CLI agent over WSS RPC
 * (`sendRpc(driveId, {method:"list"|"read"|"write", ...})`). Write
 * implicitly mkdirs parents — same as the underlying RPC.
 */
export interface FsBrowser {
  list(driveId: DriveId, path: string): Promise<FileEntry[]>;
  read(driveId: DriveId, path: string, maxBytes?: number): Promise<string>;
  write(driveId: DriveId, path: string, content: string): Promise<void>;
}

// ─── Factories — pick the right impl based on per-agent config ─────────────

/**
 * Builds an LlmClient from a per-agent LlmConfig.
 *
 * The API key comes from `config.apiKey` (stored in the drive's agent
 * JSON, protected from cap-bearers by the .aindrive/ path block) or
 * falls back to a server env var if absent. Either way, no separate
 * "owner secrets" port is needed for v1.
 *
 * Throws if `config.provider` is unknown or no key is resolvable.
 */
export interface LlmClientFactory {
  make(config: LlmConfig): Promise<LlmClient>;
}

/**
 * Builds a KnowledgeBase from a per-agent KnowledgeConfig.
 * Throws if `config.strategy` is unknown.
 */
export interface KnowledgeBaseFactory {
  make(config: KnowledgeConfig): KnowledgeBase;
}

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
