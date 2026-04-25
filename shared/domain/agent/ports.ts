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

import type { Agent, AgentId, DriveId, NewAgentInput } from "./types.js";

// ─── Persistence ───────────────────────────────────────────────────────────

export interface AgentRepo {
  byId(id: AgentId): Promise<Agent | null>;
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
 * Minimal read-side filesystem port for KnowledgeBase impls. Concrete
 * impl in v1 forwards to the existing CLI agent over WSS RPC
 * (`sendRpc(driveId, {method:"list"|"read", ...})`).
 */
export interface FsBrowser {
  list(driveId: DriveId, path: string): Promise<FileEntry[]>;
  read(driveId: DriveId, path: string, maxBytes?: number): Promise<string>;
}
