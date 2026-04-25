/**
 * Agent domain types — pure, no I/O.
 *
 * v1 demo scope (deliberately minimal):
 *   - Owner creates an Agent over a drive folder.
 *   - At ask time, the configured KnowledgeBase produces context
 *     and the LlmClient generates an answer. No upfront indexing.
 *
 * Things intentionally NOT here yet (port-ready when needed):
 *   - indexStatus / indexProgress     ← only meaningful once a
 *                                       KnowledgeBase impl pre-indexes.
 *   - pricePerCallUsdc / payment fields
 *                                     ← only meaningful when an
 *                                       x402-payer policy is wired in.
 */

export type AgentId = string;
export type DriveId = string;
export type UserId = string;

/**
 * Per-agent LLM configuration. SAFE TO STORE IN DRIVE.
 *
 * `provider` is a registry key (looked up by LlmClientFactory). `apiKey`
 * is intentionally NOT here — it lives in OwnerSecretStore server-side
 * so cap-holders reading the agent JSON can't exfiltrate the owner's key.
 */
export type LlmConfig = {
  provider: string;          // "openai", "anthropic", "vercel-gateway", …
  model: string;             // provider-specific model id
  temperature?: number;      // default 0.2 if omitted
  maxTokens?: number;        // default 400 if omitted
};

/**
 * Per-agent knowledge strategy. SAFE TO STORE IN DRIVE.
 *
 * `strategy` is a registry key (looked up by KnowledgeBaseFactory).
 * v1 has only "dump-all-text". Future strategies declare their config
 * in narrow union variants.
 */
export type KnowledgeConfig = {
  strategy: string;          // "dump-all-text", "vector-rag", "hybrid", …
};

/**
 * Per-agent access configuration. SAFE TO STORE IN DRIVE.
 *
 * `policies` is a list of registry keys to compose (firstAllow). v1
 * defaults to ["owner", "cap-holder"]. Adding "x402-payer" or
 * "subscriber" later is just adding to this array.
 */
export type AccessConfig = {
  policies: string[];        // ["owner", "cap-holder", "x402-payer", …]
};

export type Agent = {
  id: AgentId;
  driveId: DriveId;
  ownerId: UserId;
  /** Drive-relative folder path the agent answers over. "" = whole drive. */
  folder: string;
  name: string;
  description: string;
  /**
   * Public ed25519 of the drive's owned namespace. Required by the
   * cap-holder policy to verify presented capabilities are for this drive.
   */
  namespacePub: Uint8Array;
  /** Knowledge strategy (KnowledgeBase factory key + config). */
  knowledge: KnowledgeConfig;
  /** LLM provider + model + sampling params. NO secrets — see OwnerSecretStore. */
  llm: LlmConfig;
  /** Which AccessPolicies allow asking this agent. */
  access: AccessConfig;
  createdAt: number; // ms since epoch
};

export type NewAgentInput = {
  driveId: DriveId;
  ownerId: UserId;
  folder: string;
  name: string;
  description: string;
  namespacePub: Uint8Array;
  knowledge: KnowledgeConfig;
  llm: LlmConfig;
  access: AccessConfig;
};

// ─── Ask request/response ──────────────────────────────────────────────────

export type AskRequest = {
  q: string;
};

export type Source = {
  path: string;
  lineStart: number;
  lineEnd: number;
  snippet: string;
};

export type AskResult = {
  answer: string;
  sources: Source[];
};
