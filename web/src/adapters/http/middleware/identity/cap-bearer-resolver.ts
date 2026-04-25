/**
 * IdentityResolver that decodes a Meadowcap capability presented as
 * either an Authorization: Bearer header or an aindrive_cap cookie.
 *
 * Verification (signature chain, area extraction) is delegated to
 * decodeAndDescribeCap. We additionally:
 *   - require valid === true (signature chain checks out)
 *   - require not-yet-expired (timeEnd > now)
 *
 * Returns { kind: "anonymous" } on any failure so the composite
 * resolver can fall back to other resolvers.
 */

import { decodeAndDescribeCap, bytesToHex } from "../../../../../lib/willow/cap-issue";
import type {
  CallerIdentity,
  IdentityResolveInput,
  IdentityResolver,
} from "../../../../../../shared/domain/agent/access";

function readCapToken(req: IdentityResolveInput): string | null {
  const auth = req.headers.get("authorization");
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return req.cookies.get("aindrive_cap") ?? null;
}

export const capBearerResolver: IdentityResolver = {
  name: "cap-bearer",
  async resolve(req: IdentityResolveInput): Promise<CallerIdentity> {
    const token = readCapToken(req);
    if (!token) return { kind: "anonymous" };

    const decoded = await decodeAndDescribeCap(token);
    if (!decoded || !decoded.valid) return { kind: "anonymous" };

    const expiresAt =
      decoded.timeEnd === null ? Number.MAX_SAFE_INTEGER : Number(decoded.timeEnd);
    if (expiresAt <= Date.now()) return { kind: "anonymous" };

    return {
      kind: "cap-bearer",
      recipientHex: bytesToHex(decoded.receiverPub),
      namespacePubHex: bytesToHex(decoded.namespacePub),
      pathPrefix: decoded.pathPrefix,
      expiresAt,
    };
  },
};
