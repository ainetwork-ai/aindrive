/**
 * Cap-holder policy — anyone presenting a verified Meadowcap capability
 * whose granted area covers the agent's folder may use it.
 *
 * The cap is verified upstream by the IdentityResolver (Track A's
 * verifyCapBearer); this policy only checks that the verified cap's
 * pathPrefix is an ancestor of the agent's folder.
 */

import type { AccessPolicy } from "../../../../../shared/domain/agent/access";
import { pathCovers } from "../../../../../shared/domain/policy/path";
import { bytesToHex } from "../../../../lib/willow/cap-issue";

export const capHolderPolicy: AccessPolicy = {
  name: "cap-holder",
  async decide({ agent, caller }) {
    if (caller.kind !== "cap-bearer") {
      return { kind: "deny", reason: "not_cap_bearer" };
    }
    if (caller.expiresAt <= Date.now()) {
      return { kind: "deny", reason: "cap_expired" };
    }
    if (caller.namespacePubHex !== bytesToHex(agent.namespacePub)) {
      return { kind: "deny", reason: "cap_namespace_mismatch" };
    }
    if (!pathCovers(caller.pathPrefix, agent.folder)) {
      return { kind: "deny", reason: "cap_path_out_of_scope" };
    }
    return { kind: "allow", reason: `cap:${caller.recipientHex.slice(0, 8)}` };
  },
};
