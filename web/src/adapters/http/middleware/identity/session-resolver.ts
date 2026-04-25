/**
 * IdentityResolver that reads the existing aindrive session cookie
 * (`aindrive_session`, JWT signed with the server session secret).
 *
 * Mirrors the verification done in web/lib/dochub.js#readUserFromCookie.
 * On any failure (no cookie / bad sig / no `sub` claim) returns
 * { kind: "anonymous" } so the next resolver in the composite chain
 * gets to try.
 */

import { verify } from "../../../../../lib/session";
import type {
  CallerIdentity,
  IdentityResolveInput,
  IdentityResolver,
} from "@/shared/domain/agent/access";

export const sessionResolver: IdentityResolver = {
  name: "session",
  async resolve(req: IdentityResolveInput): Promise<CallerIdentity> {
    const token = req.cookies.get("aindrive_session");
    if (!token) return { kind: "anonymous" };
    const userId = await verify(token);
    return userId ? { kind: "session-user", userId } : { kind: "anonymous" };
  },
};
