import { NextResponse } from "next/server";
import { getRequestUser, getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { atLeast, type Role } from "@/lib/access";
import { normalizePath } from "./path";
import { isSystemPath } from "@/shared/domain/policy/system-paths";
import { HTTP_STATUS_FOR, makeError } from "./shared-items";
import { bearerOf, isResourceDelegationToken, resolveDelegatedCaller, type ResourceAction } from "./resource-delegation";

// The decision core (DriveGate, readDenial, gateDriveRoleForUser) lives in
// lib/drive-gate.ts — no Next imports, so the git-over-SSH process can bundle
// it; this module is its HTTP front (cookie / bearer / delegation → user id).
export { readDenial, type ReadDenial, type DriveGate } from "./drive-gate";
import { gateDriveRoleForUser as gateForUser, readDenial, type DriveGate } from "./drive-gate";
import { isServiceToken, logServiceRead, serviceRoleInDrive, verifyServiceToken } from "./sso/service-principal";

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
 *   - reserved `.aindrive/`    -> 403 { error: "reserved path" } (any role)
 *   - missing drive            -> 404 { error: "drive not found" }
 *   - insufficient role + user -> 403 { error: "forbidden" }
 *   - insufficient role, anon  -> 401 { error: "forbidden" }
 * The JSON error body only ever appears on the failure path, so streaming
 * routes (fs/read, fs/download) keep full control of their success response.
 *
 * `opts.req` (byte routes: fs/thumbnail, fs/stream, fs/download) also accepts
 * `Authorization: Bearer <session JWT>` in place of the cookie, for server-side
 * hosts that proxy file bytes (AINUI assets, docs/AINUI.md §2). Only session
 * JWTs — not MCP/OAuth tokens — and an invalid bearer is a 401, never a fall
 * back to the cookie. Every check below applies unchanged.
 *
 * `opts.delegation` (fs/read, fs/list only) additionally accepts
 * `Authorization: Bearer <ain-rdlg+jwt>` — an agent reading ON BEHALF of the
 * delegated account (lib/resource-delegation.ts: signature, audience, proof
 * of possession, revocation, then the three checks: the linked account may
 * read here right now, the grant names this file or an ancestor folder with
 * this action, the token is live). The gate then holds the linked account's
 * live role, so every check below (paid carve-out, reserved subtree) applies
 * as for that account; `gate.delegation` carries the claims. Refusals use
 * the contract error body. Only `read` and `list` can be delegated: no write
 * route passes this option, and the module refuses other actions.
 *
 * `opts.service` (with `opts.req`; git upload-pack, git-meta) additionally
 * accepts `Authorization: Bearer <AIN SSO machine token>` from a trusted
 * first-party application acting as itself (lib/sso/service-principal.ts:
 * signature, issuer, audience = this aindrive, expiry, `sub` on the trust
 * list). Such a caller is a viewer on the drives shared with an organization
 * the application is assigned in, and nothing more: a route asking for
 * editor+ gets 403, the reserved subtree and the paid carve-out apply as for
 * any viewer, and `gate.service` names the application. A token that looks
 * like one but does not verify is a 401, never a fall back to the cookie.
 */
export async function requireDriveRole(
  driveId: string,
  targetPath: string,
  opts: { min: Role; req?: Request; delegation?: { req: Request; action: Extract<ResourceAction, "read" | "list"> }; service?: boolean },
): Promise<DriveGate | NextResponse> {
  // `.aindrive/` holds the agent token, drive secret and agent API keys: no
  // role, not even owner, reaches it through a drive route. Checked on the
  // canonical form so "/.aindrive" or "./.aindrive//x" can't slip by.
  let canonical: string;
  try { canonical = normalizePath(targetPath); }
  catch { return NextResponse.json({ error: "invalid path" }, { status: 400 }); }
  if (opts.delegation && isResourceDelegationToken(bearerOf(opts.delegation.req))) {
    // Delegated read: the account is the token's `sub`, never the cookie. A
    // delegation only ever reaches a viewer-level read (opts.min is "viewer"
    // on both routes); the module refuses reserved and paid-unbought paths.
    const d = await resolveDelegatedCaller(opts.delegation.req, { driveId, path: canonical, action: opts.delegation.action });
    if (!d.ok) {
      const extra: Record<string, string> = d.code === "auth_required" ? { "WWW-Authenticate": 'Bearer error="invalid_token"' } : {};
      return NextResponse.json(makeError(d.code, d.message, { detail: d.reason }), { status: HTTP_STATUS_FOR[d.code], headers: { "Cache-Control": "no-store", ...extra } });
    }
    const drive = getDrive(driveId);
    if (!drive) return NextResponse.json(makeError("forbidden", "the delegation does not grant this action on this file", { detail: "not_granted" }), { status: 403, headers: { "Cache-Control": "no-store" } });
    if (!atLeast(d.role, opts.min)) return NextResponse.json(makeError("forbidden", "the delegated account may not do this", { detail: "user_forbidden" }), { status: 403, headers: { "Cache-Control": "no-store" } });
    const { ok: _ok, ...delegation } = d;
    return { drive, role: d.role, userId: d.userId, delegation };
  }
  // Reserved subtree is refused before any identity is read (as it always was:
  // an invalid bearer on `.aindrive/…` is still a 403, not a 401).
  if (isSystemPath(canonical)) return NextResponse.json({ error: "reserved path" }, { status: 403 });
  if (opts.service && opts.req && isServiceToken(bearerOf(opts.req))) {
    // A first-party application acting as itself: the role comes from the token's organizations,
    // never from a cookie; viewer is the ceiling, so this path is read-only by construction.
    const v = await verifyServiceToken(bearerOf(opts.req)!);
    if (!v.ok) {
      return NextResponse.json({ error: "invalid service token", reason: v.reason }, { status: 401, headers: { "Cache-Control": "no-store", "WWW-Authenticate": 'Bearer error="invalid_token"' } });
    }
    const drive = getDrive(driveId);
    if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });
    const role = serviceRoleInDrive(driveId, v.principal);
    if (role === "none" || !atLeast(role, opts.min)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const denial = readDenial(driveId, canonical, role, null);
    if (denial?.kind === "payment") return NextResponse.json({ error: "payment required", reason: "payment_required" }, { status: 402 });
    logServiceRead(v.principal, driveId, canonical, `${opts.min} gate`);
    return { drive, role, userId: null, service: v.principal };
  }
  const user = opts.req ? await getRequestUser(opts.req) : await getUser();
  if (user === "invalid") return NextResponse.json({ error: "invalid bearer token" }, { status: 401 });
  const gate = await gateForUser(driveId, targetPath, { min: opts.min, userId: user?.id ?? null });
  if ("denied" in gate) return NextResponse.json(gate.body, { status: gate.status });
  return gate;
}

// The identity-free gate lives in lib/drive-gate.ts (no Next imports, so the
// git-over-SSH process can bundle it); re-exported here for route code.
export { gateDriveRoleForUser, type GateDenial } from "./drive-gate";

