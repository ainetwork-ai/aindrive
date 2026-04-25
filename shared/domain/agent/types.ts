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
  createdAt: number; // ms since epoch
};

export type NewAgentInput = {
  driveId: DriveId;
  ownerId: UserId;
  folder: string;
  name: string;
  description: string;
  namespacePub: Uint8Array;
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
