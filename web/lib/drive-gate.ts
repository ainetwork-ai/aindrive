import { getDrive, type DriveRow } from "@/lib/drives";
import { resolveAccess, atLeast, type Role, type RoleOrNone } from "@/lib/access";
import { paidAccessDenial, type PaidDenial } from "./sale-access.js";
import { normalizePath } from "./path";
import { isSystemPath } from "@/shared/domain/policy/system-paths";
import type { DelegatedCaller } from "./resource-delegation";

/**
 * The drive gate's decision core, free of any HTTP or Next import: who may do
 * what at a path, given a USER ID. lib/require-access.ts (cookie / bearer /
 * delegation → user id → NextResponse) is built on it for every route, and
 * lib/git-ssh/server.ts applies it directly for the user an SSH key resolved
 * to — one gate, two front doors. It is bundled into the git-over-SSH process
 * (scripts/build-ssh-server.mjs), which is why nothing from `next/*` may be
 * imported here.
 */
export type DriveGate = {
  drive: DriveRow;
  role: Role;
  userId: string | null;
  /** Set when the caller is an agent acting under a resource delegation (lib/resource-delegation.ts). */
  delegation?: DelegatedCaller;
};

export type ReadDenial =
  | { kind: "reserved" }
  | ({ kind: "payment" } & PaidDenial);

/**
 * Why a user holding `role` at `canonicalPath` still may not READ it: the
 * reserved `.aindrive/` subtree, or a paid subtree they haven't bought. null =
 * readable. The one read decision beyond the role — shared by the fs/* gate
 * and the drive page's stat, so the page can't reveal by stat (a file's
 * existence, size, mtime) what the API withholds by 402/403.
 */
export function readDenial(driveId: string, canonicalPath: string, role: RoleOrNone, userId: string | null): ReadDenial | null {
  if (isSystemPath(canonicalPath)) return { kind: "reserved" };
  const paid = paidAccessDenial(driveId, canonicalPath, role, userId);
  return paid ? { kind: "payment", ...paid } : null;
}

export type GateDenial = { denied: true; status: 400 | 401 | 403 | 404 | 402; body: Record<string, unknown> };

/**
 * The drive gate for a caller whose identity is already a user id — git over
 * SSH (lib/git-ssh/*), where the user comes from the SSH key, not a cookie or
 * bearer. Same checks in the same order, same outcomes as requireDriveRole's
 * cookie/bearer path (reserved `.aindrive/` → 403, missing drive → 404,
 * insufficient role → 403 with a user / 401 without, paid carve-out → 402);
 * only the envelope differs: a plain { denied, status, body } instead of a
 * NextResponse, since no HTTP response is being built. requireDriveRole is
 * built on it, so the two can never drift.
 */
export async function gateDriveRoleForUser(
  driveId: string,
  targetPath: string,
  opts: { min: Role; userId: string | null },
): Promise<DriveGate | GateDenial> {
  let canonical: string;
  try { canonical = normalizePath(targetPath); }
  catch { return { denied: true, status: 400, body: { error: "invalid path" } }; }
  if (isSystemPath(canonical)) return { denied: true, status: 403, body: { error: "reserved path" } };
  const drive = getDrive(driveId);
  if (!drive) return { denied: true, status: 404, body: { error: "drive not found" } };
  const role = await resolveAccess(driveId, targetPath, opts.userId);
  if (!atLeast(role, opts.min)) {
    return { denied: true, status: opts.userId ? 403 : 401, body: { error: "forbidden" } };
  }
  // Paid carve-out (read gate): a priced subtree is removed from a bare viewer
  // grant's reach — editor+ (managers) and entitled buyers pass; an unentitled
  // viewer is sent to the paywall. Only viewers can be denied here ("none" was
  // already 401/403 above). See docs/PERMISSIONS_MATRIX.md R-ACC-PAID-*.
  const denial = readDenial(driveId, canonical, role, opts.userId);
  if (denial?.kind === "payment") {
    const { kind: _kind, ...gate } = denial;
    return { denied: true, status: 402, body: { error: "payment required", reason: "payment_required", ...gate } };
  }
  // role >= opts.min >= "viewer", so it is a concrete Role, never "none".
  return { drive, role: role as Role, userId: opts.userId };
}
