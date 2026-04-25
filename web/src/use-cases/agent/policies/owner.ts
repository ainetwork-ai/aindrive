/**
 * Owner policy — the agent's owner can always use it.
 *
 * Recognizes `session-user` callers and matches userId against the agent's
 * `ownerId`. Anyone else is denied (let other policies in the chain decide).
 */

import type { AccessPolicy } from "@/shared/domain/agent/access";

export const ownerPolicy: AccessPolicy = {
  name: "owner",
  async decide({ agent, caller }) {
    if (caller.kind === "session-user" && caller.userId === agent.ownerId) {
      return { kind: "allow", reason: "owner" };
    }
    return { kind: "deny", reason: "not_owner" };
  },
};
