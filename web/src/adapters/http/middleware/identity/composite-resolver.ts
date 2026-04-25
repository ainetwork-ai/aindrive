/**
 * Composite IdentityResolver — tries each child in order, returns the
 * first non-anonymous result.
 *
 * Default order is session first (most specific — proves who the user
 * is), then cap-bearer (anonymous-but-authorized via cap). The order
 * matters: a logged-in owner who happens to also hold a cap should be
 * recognized as the owner, so ownerPolicy fires before capHolderPolicy.
 */

import type {
  CallerIdentity,
  IdentityResolveInput,
  IdentityResolver,
} from "../../../../../../shared/domain/agent/access.js";

export function compositeResolver(
  children: ReadonlyArray<IdentityResolver>,
): IdentityResolver {
  return {
    name: `composite(${children.map((c) => c.name).join(",")})`,
    async resolve(req: IdentityResolveInput): Promise<CallerIdentity> {
      for (const r of children) {
        const id = await r.resolve(req);
        if (id.kind !== "anonymous") return id;
      }
      return { kind: "anonymous" };
    },
  };
}
