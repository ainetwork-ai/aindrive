/**
 * Access control for the Agent feature.
 *
 * The whole reason this file exists separately from `types.ts`:
 * "who is allowed to use this agent" changes shape over time. By placing
 * the abstraction here behind interfaces, adding a new way to authorize
 * (subscriber? referral chain? DAO membership?) is one new file plus one
 * line in composition — never a change to `askAgent`.
 *
 * See: docs/personal/haechan/AGENT_FEATURE_DESIGN.md
 */

import type { Agent, AskRequest } from "./types.js";

// ─── Caller identity ───────────────────────────────────────────────────────

/**
 * Who is asking? Each variant corresponds to one authentication mechanism.
 *
 * Adding a new mechanism = add a `kind` here + a corresponding
 * `IdentityResolver` implementation. Existing policies keep working
 * (they switch on `kind` and ignore unknowns).
 */
export type CallerIdentity =
  /** No credentials presented (or all failed to verify). */
  | { kind: "anonymous" }

  /** Authenticated as an aindrive user via session cookie. */
  | { kind: "session-user"; userId: string }

  /**
   * Presented a verified Meadowcap capability covering some path prefix.
   * `recipientHex` uniquely identifies the cap holder for rate limiting.
   */
  | {
      kind: "cap-bearer";
      recipientHex: string;
      pathPrefix: string;
      expiresAt: number; // ms
    }

  /**
   * Presented a valid X-PAYMENT (a2a-x402) for the agent's per-call price.
   * Single-use — the nonce prevents replay.
   */
  | {
      kind: "x402-payer";
      payerAddress: string;
      paidUsdc: number;
      nonce: string;
    };

// ─── Decision shape ────────────────────────────────────────────────────────

export type PaymentRequirement = {
  scheme: "x402-payment" | string; // pluggable for future payment schemes
  priceUsdc: number;
  network: string; // e.g. "base-sepolia"
  payTo: string;   // owner wallet
  facilitator: string;
  nonce?: string;
};

/**
 * Outcome of a policy decision. Discriminated union so the route can map
 * each kind to a distinct HTTP status without conditionals on internals.
 */
export type AccessDecision =
  | { kind: "allow"; reason: string }
  | { kind: "deny"; reason: string }
  | { kind: "require-payment"; requirement: PaymentRequirement }
  | { kind: "rate-limited"; retryAfterMs: number };

// ─── The contract ──────────────────────────────────────────────────────────

export type AccessRequest = {
  agent: Agent;
  caller: CallerIdentity;
  request: AskRequest;
};

/**
 * The plug-in point for "who may use this agent".
 *
 * Implementations should be:
 *   - Pure functions of (agent, caller, request) where possible.
 *   - Side-effect-only via injected ports (rate-limit store, payment
 *     verifier already-verified at resolver stage, etc.) — never direct DB/HTTP.
 *
 * Compose multiple policies via the helpers in
 * web/src/use-cases/agent/policies/compose.ts.
 */
export interface AccessPolicy {
  /** Stable id for logs and composition (e.g. "owner", "cap-holder"). */
  readonly name: string;
  decide(req: AccessRequest): Promise<AccessDecision>;
}

/**
 * Inspects an HTTP request and produces the strongest identity claim it
 * can verify. Returning `{ kind: "anonymous" }` is always valid — let the
 * policy decide whether anonymous is acceptable.
 *
 * Adding a new `CallerIdentity` variant requires a new resolver (or
 * extending an existing composite resolver to try the new mechanism).
 */
export interface IdentityResolver {
  readonly name: string;
  resolve(req: IdentityResolveInput): Promise<CallerIdentity>;
}

export type IdentityResolveInput = {
  /** Lowercase header name → value. Adapter is responsible for normalizing. */
  headers: ReadonlyMap<string, string>;
  /** Cookie name → value. */
  cookies: ReadonlyMap<string, string>;
};
