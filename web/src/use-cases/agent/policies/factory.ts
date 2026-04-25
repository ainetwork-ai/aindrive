/**
 * AccessPolicyFactory — builds a composed policy from a name list.
 *
 * v1 registry: "owner", "cap-holder". Composition is firstAllow.
 * Adding "x402-payer" / "subscriber" / etc. = register the policy
 * here and it becomes available to every agent's AccessConfig.
 */

import type {
  AccessPolicy,
} from "@/shared/domain/agent/access";
import type {
  AccessPolicyFactory,
} from "@/shared/domain/agent/ports";
import type {
  AccessConfig,
} from "@/shared/domain/agent/types";
import { ownerPolicy } from "./owner";
import { capHolderPolicy } from "./cap-holder";
import { firstAllow } from "./compose";

const REGISTRY: Record<string, AccessPolicy> = {
  owner: ownerPolicy,
  "cap-holder": capHolderPolicy,
};

export const accessPolicyFactory: AccessPolicyFactory = {
  make(config: AccessConfig): AccessPolicy {
    if (config.policies.length === 0) {
      throw new Error("empty_access_config");
    }
    const resolved: AccessPolicy[] = [];
    for (const name of config.policies) {
      const p = REGISTRY[name];
      if (!p) throw new Error(`unknown_policy:${name}`);
      resolved.push(p);
    }
    return resolved.length === 1 ? resolved[0] : firstAllow(resolved);
  },
};
