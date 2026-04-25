/**
 * Policy composers — combine multiple AccessPolicy instances into one.
 *
 * Adding a new auth method = (1) new policy file, (2) one extra entry
 * in the array passed to a composer (usually `firstAllow`). `askAgent`
 * remains untouched.
 */

import type {
  AccessDecision,
  AccessPolicy,
  AccessRequest,
} from "../../../../../shared/domain/agent/access";

/**
 * First `allow` wins. If none allow, returns the most informative
 * non-allow in priority order:
 *   1. require-payment (so caller knows how to proceed)
 *   2. rate-limited
 *   3. last deny seen
 *
 * This is the default for "many ways to qualify" scenarios.
 */
export function firstAllow(policies: ReadonlyArray<AccessPolicy>): AccessPolicy {
  if (policies.length === 0) {
    throw new Error("firstAllow requires at least one policy");
  }
  return {
    name: `firstAllow(${policies.map((p) => p.name).join(",")})`,
    async decide(req: AccessRequest): Promise<AccessDecision> {
      let lastDeny: AccessDecision | null = null;
      let firstPaymentReq: AccessDecision | null = null;
      let firstRateLimit: AccessDecision | null = null;

      for (const p of policies) {
        const d = await p.decide(req);
        if (d.kind === "allow") return d;
        if (d.kind === "require-payment" && !firstPaymentReq) firstPaymentReq = d;
        else if (d.kind === "rate-limited" && !firstRateLimit) firstRateLimit = d;
        else if (d.kind === "deny") lastDeny = d;
      }

      return (
        firstPaymentReq ??
        firstRateLimit ??
        lastDeny ??
        { kind: "deny", reason: "no_policy_matched" }
      );
    },
  };
}

/**
 * All must allow. Rare but useful for compound requirements
 * (e.g. paid AND in-region AND not-blocklisted).
 */
export function allOf(policies: ReadonlyArray<AccessPolicy>): AccessPolicy {
  if (policies.length === 0) {
    throw new Error("allOf requires at least one policy");
  }
  return {
    name: `allOf(${policies.map((p) => p.name).join(",")})`,
    async decide(req: AccessRequest): Promise<AccessDecision> {
      for (const p of policies) {
        const d = await p.decide(req);
        if (d.kind !== "allow") return d;
      }
      return { kind: "allow", reason: `allOf:${policies.map((p) => p.name).join(",")}` };
    },
  };
}

/**
 * First `deny` short-circuits — used to layer security gates (blocklist,
 * geofence) in front of normal policies.
 */
export function firstDenyElse(
  gates: ReadonlyArray<AccessPolicy>,
  fallback: AccessPolicy,
): AccessPolicy {
  return {
    name: `firstDenyElse([${gates.map((g) => g.name).join(",")}], ${fallback.name})`,
    async decide(req: AccessRequest): Promise<AccessDecision> {
      for (const g of gates) {
        const d = await g.decide(req);
        if (d.kind === "deny") return d;
      }
      return fallback.decide(req);
    },
  };
}
