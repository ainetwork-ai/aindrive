/**
 * HTTP contracts shared across tracks.
 *
 * These types are the FROZEN agreement between Track A (Cap & Pay),
 * Track B (RAG + A2A), and Track C (UX). Changing any shape here
 * REQUIRES a 3-track sync — do not modify alone.
 *
 * See: docs/HACKATHON_PLAN.md §6 (4 contracts), docs/ARCHITECTURE.md §4
 */

// ─────────────────────────────────────────────────────────────────────────
// 1. Pay → Cap issuance (Track A → Track C)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Returned by POST /api/s/[token]/pay on success.
 * The browser also receives an httpOnly cookie `aindrive_cap` with the same value.
 */
export type PaySuccessResponse = {
  ok: true;
  cap: string;             // base64url Meadowcap capability bytes
  expiresAt: number;       // milliseconds since epoch
  pathPrefix: string;      // e.g. "docs/q1" — area covered by this cap
  driveId: string;
};

export type PayErrorResponse = {
  ok: false;
  error: "payment_invalid" | "share_not_found" | "share_expired" | "facilitator_unreachable";
};

// ─────────────────────────────────────────────────────────────────────────
// 2. Cap verification (Track A → Track A routes & Track B agent ask)
// ─────────────────────────────────────────────────────────────────────────

export type CapVerifyOk = {
  ok: true;
  area: {
    pathPrefix: string;
    expiresAt: number;
    recipientHex: string;  // hex of recipient ed25519 pubkey from cap
  };
};

export type CapVerifyError = {
  ok: false;
  reason:
    | "cap_invalid"             // signature chain bad / decode failed
    | "cap_expired"             // now > area.timeRange.end
    | "cap_namespace_mismatch"  // cap is for a different drive
    | "cap_path_out_of_scope";  // requested path not under area.pathPrefix
};

export type CapVerifyResult = CapVerifyOk | CapVerifyError;

// ─────────────────────────────────────────────────────────────────────────
// 3. Agent ask response (Track B → Track C)
// ─────────────────────────────────────────────────────────────────────────

export type RagSource = {
  path: string;       // drive-relative, e.g. "docs/q1-okr.md"
  lineStart: number;  // 1-indexed
  lineEnd: number;    // inclusive
  snippet: string;    // up to ~300 chars, the chunk text
};

export type RagAnswer = {
  answer: string;
  sources: RagSource[];
};

/** POST /api/agent/[id]/ask request body */
export type AskRequestBody = {
  q: string;
  k?: number;  // default 5
};

/**
 * 402 response shape when caller has neither cap nor X-PAYMENT.
 * Conforms to a2a-x402 wire format.
 *
 * See: https://github.com/google-agentic-commerce/a2a-x402
 */
export type PaymentRequiredResponse = {
  paymentRequirements: {
    scheme: "x402-payment";
    priceUsdc: number;
    network: string;        // e.g. "base-sepolia"
    payTo: string;          // owner wallet address
    facilitator: string;    // e.g. "https://x402.org/facilitator"
    nonce?: string;
  };
};

// ─────────────────────────────────────────────────────────────────────────
// 4. Agent Card security scheme IDs (Track B owns; Track C displays)
// ─────────────────────────────────────────────────────────────────────────

export const SCHEME_X402 = "x402-payment";
export const SCHEME_CAP  = "aindrive-cap";

/**
 * Subset of A2A v1 AgentCard JSON published at
 * GET /.well-known/agent-card/[id].json
 *
 * Spec: https://a2a-protocol.org/latest/specification/
 */
export type AindriveAgentCard = {
  name: string;
  description: string;
  version: string;
  supportedInterfaces: Array<{
    url: string;
    protocolBinding: "HTTP+JSON" | "JSONRPC" | "GRPC";
    protocolVersion: string;
  }>;
  capabilities: { streaming: boolean; pushNotifications: boolean };
  securitySchemes: {
    [SCHEME_X402]: { type: "custom"; spec: string };
    [SCHEME_CAP]:  { type: "http"; scheme: "bearer"; description: string };
  };
  security: Array<Record<string, string[]>>;
  skills: Array<{
    id: string;
    name: string;
    description: string;
    tags: string[];
  }>;
  defaultInputModes: string[];
  defaultOutputModes: string[];
};
