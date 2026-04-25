/**
 * Agent domain types — pure, no I/O.
 *
 * "Agent" = a RAG agent published over a folder of an aindrive drive.
 * Owner creates one (`createAgent`). Anyone authorized by the configured
 * AccessPolicy can ask it (`askAgent`).
 */

export type AgentId = string;
export type DriveId = string;
export type UserId = string;

/** What we know about an agent at rest. */
export type Agent = {
  id: AgentId;
  driveId: DriveId;
  ownerId: UserId;
  /** Drive-relative folder path the agent indexes, e.g. "docs/q1". "" = whole drive. */
  folder: string;
  name: string;
  description: string;

  /**
   * Public ed25519 of the drive's owned namespace — required for cap-bearer
   * verification (Track A's verifyCapBearer takes this as expectedNamespace).
   */
  namespacePub: Uint8Array;

  /**
   * Per-call USDC price for x402 callers. `null` = no x402 path enabled
   * (only cap-holder / owner / other policies can use this agent).
   */
  pricePerCallUsdc: number | null;
  paymentChain: string;        // e.g. "base-sepolia"
  paymentAddress: string | null; // owner's wallet to receive payments

  indexStatus: "pending" | "indexing" | "ready" | "failed";
  /** 0..100 percent for UI; only meaningful while indexStatus === "indexing". */
  indexProgress: number;

  createdAt: number; // ms since epoch
};

/** Inputs for creating an agent — owner only. */
export type NewAgentInput = {
  driveId: DriveId;
  ownerId: UserId;
  folder: string;
  name: string;
  description: string;
  namespacePub: Uint8Array;
  pricePerCallUsdc?: number | null;
  paymentChain?: string;
  paymentAddress?: string | null;
};

// ─── Ask request/response ──────────────────────────────────────────────────

export type AskRequest = {
  q: string;
  k?: number; // top-k for retrieval, default 5
};

export type Source = {
  path: string;       // drive-relative, e.g. "docs/q1-okr.md"
  lineStart: number;  // 1-indexed
  lineEnd: number;    // inclusive
  snippet: string;    // up to ~300 chars
};

export type AskResult = {
  answer: string;
  sources: Source[];
};
