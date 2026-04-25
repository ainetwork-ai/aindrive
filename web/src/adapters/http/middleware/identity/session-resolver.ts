/**
 * IdentityResolver that reads the existing aindrive session cookie
 * (`aindrive_session`, JWT signed with the server session secret).
 *
 * Mirrors the verification done in web/lib/dochub.js#readUserFromCookie.
 * On any failure (no cookie / bad sig / no `sub` claim) returns
 * { kind: "anonymous" } so the next resolver in the composite chain
 * gets to try.
 */

import { jwtVerify } from "jose";
import { env } from "../../../../../lib/env.js";
import type {
  CallerIdentity,
  IdentityResolveInput,
  IdentityResolver,
} from "../../../../../../shared/domain/agent/access.js";

const enc = new TextEncoder();

export const sessionResolver: IdentityResolver = {
  name: "session",
  async resolve(req: IdentityResolveInput): Promise<CallerIdentity> {
    const token = req.cookies.get("aindrive_session");
    if (!token) return { kind: "anonymous" };
    try {
      const { payload } = await jwtVerify(token, enc.encode(env.sessionSecret));
      const userId = typeof payload.sub === "string" ? payload.sub : null;
      if (!userId) return { kind: "anonymous" };
      return { kind: "session-user", userId };
    } catch {
      return { kind: "anonymous" };
    }
  },
};
