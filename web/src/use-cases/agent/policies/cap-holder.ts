/**
 * Cap-holder policy — anyone presenting a verified Meadowcap capability
 * whose granted area covers the agent's folder may use it.
 *
 * The cap is verified upstream by the IdentityResolver (Track A's
 * verifyCapBearer); this policy only checks that the verified cap's
 * pathPrefix is an ancestor of the agent's folder.
 */

import type { AccessPolicy } from "../../../../../shared/domain/agent/access.js";

/**
 * "ancestor" means the cap's pathPrefix is "" (whole drive) or
 * equals the agent's folder, or the agent's folder starts with
 * `pathPrefix + "/"`. Same semantics as Willow's path-prefix area.
 */
function pathCovers(prefix: string, target: string): boolean {
  if (prefix === "" || prefix === target) return true;
  return target.startsWith(prefix + "/");
}

export const capHolderPolicy: AccessPolicy = {
  name: "cap-holder",
  async decide({ agent, caller }) {
    if (caller.kind !== "cap-bearer") {
      return { kind: "deny", reason: "not_cap_bearer" };
    }
    if (caller.expiresAt <= Date.now()) {
      return { kind: "deny", reason: "cap_expired" };
    }
    if (!pathCovers(caller.pathPrefix, agent.folder)) {
      return { kind: "deny", reason: "cap_path_out_of_scope" };
    }
    return { kind: "allow", reason: `cap:${caller.recipientHex.slice(0, 8)}` };
  },
};
