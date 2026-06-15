import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { getDrive, type DriveRow } from "@/lib/drives";
import { resolveAccess, atLeast, type Role } from "@/lib/access";
import { paidAccessDenial } from "./sale-access.js";

export type DriveGate = { drive: DriveRow; role: Role };

/**
 * Shared authorization gate for drive-scoped API routes (fs/*, yjs).
 *
 * Collapses the four-step pattern every such route repeated by hand:
 *   getUser → getDrive (404) → resolveAccess(path) → atLeast(min) (401/403).
 *
 * Returns { drive, role } on success so the caller can keep using
 * drive.drive_secret / drive.owner_id / the resolved role. On failure returns
 * a ready-to-return NextResponse — callers do:
 *
 *   const gate = await requireDriveRole(driveId, path, { min: "viewer" });
 *   if (gate instanceof NextResponse) return gate;
 *   const { drive, role } = gate;
 *
 * Error semantics are preserved exactly from the previous inline code:
 *   - missing drive            -> 404 { error: "drive not found" }
 *   - insufficient role + user -> 403 { error: "forbidden" }
 *   - insufficient role, anon  -> 401 { error: "forbidden" }
 * The JSON error body only ever appears on the failure path, so streaming
 * routes (fs/read, fs/download) keep full control of their success response.
 */
export async function requireDriveRole(
  driveId: string,
  targetPath: string,
  opts: { min: Role },
): Promise<DriveGate | NextResponse> {
  const user = await getUser();
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });
  const role = await resolveAccess(driveId, targetPath, user?.id ?? null);
  if (!atLeast(role, opts.min)) {
    return NextResponse.json({ error: "forbidden" }, { status: user ? 403 : 401 });
  }
  // Paid carve-out (read gate): a priced subtree is removed from a bare viewer
  // grant's reach — editor+ (managers) and entitled buyers pass; an unentitled
  // viewer is sent to the paywall. Only viewers can be denied here ("none" was
  // already 401/403 above). See docs/PERMISSIONS_MATRIX.md R-ACC-PAID-*.
  const denial = paidAccessDenial(driveId, targetPath, role, user?.id ?? null);
  if (denial) {
    return NextResponse.json(
      { error: "payment required", reason: "payment_required", ...denial },
      { status: 402 },
    );
  }
  // role >= opts.min >= "viewer", so it is a concrete Role, never "none".
  return { drive, role: role as Role };
}
