/**
 * Who a consumer application is asking FOR (docs/AINUI-LINK-SNIPPETS.md §1):
 *
 *   Authorization: Bearer <AIN SSO client_credentials token, aud = this aindrive>
 *   X-AIN-Actor: <the viewer's AIN SSO subject>
 *
 * The token stands for the application (lib/sso/service-principal.ts: signed by
 * the issuer, for this aindrive, from a client_id on AINDRIVE_SSO_SERVICE_APPS);
 * the header names the person. The person's access is THEIR drive role — the
 * account their subject is linked to here (sso_identities), through the same gate
 * every page uses — never the application's. A named subject nobody here is
 * linked to is a person with no access (403), not an error.
 *
 * Without the actor header the application acts as itself: a viewer on the
 * drives shared with one of the token's organizations, as for git upload-pack.
 */
import { gateDriveRoleForUser, type DriveGate, type GateDenial } from "./drive-gate";
import { getDrive } from "./drives";
import { readDenial } from "./drive-gate";
import { normalizePath } from "./path";
import { adapterConfig } from "./sso/config";
import { bearerOf, isServiceToken, logServiceRead, serviceRoleInDrive, verifyServiceToken, type ServicePrincipal } from "./sso/service-principal";
import { identityFor } from "./sso/store.js";

export const ACTOR_HEADER = "x-ain-actor";
/** An AIN SSO subject: printable, no whitespace, bounded (what ainize-node's run-actor accepts too). */
const SUBJECT = /^[A-Za-z0-9._:@%+/-]{1,300}$/;

export type ActingCaller =
  | { kind: "none" }
  | { kind: "refused"; status: 400 | 401; body: { error: string; reason?: string } }
  | { kind: "app"; principal: ServicePrincipal }
  | { kind: "actor"; principal: ServicePrincipal; subject: string; userId: string | null };

/** Reads the two headers. `none` when the bearer is not a machine token (cookies and other bearers keep their own paths). */
export async function resolveActingCaller(req: Request): Promise<ActingCaller> {
  const token = bearerOf(req);
  if (!isServiceToken(token)) return { kind: "none" };
  const v = await verifyServiceToken(token!);
  if (!v.ok) return { kind: "refused", status: 401, body: { error: "invalid service token", reason: v.reason } };
  const subject = (req.headers.get(ACTOR_HEADER) ?? "").trim();
  if (!subject) return { kind: "app", principal: v.principal };
  if (!SUBJECT.test(subject)) return { kind: "refused", status: 400, body: { error: "invalid actor", reason: "X-AIN-Actor is not an AIN SSO subject" } };
  const cfg = adapterConfig();
  const ident = cfg ? (identityFor(cfg.issuer, subject) as { user_id: string } | undefined) : undefined;
  return { kind: "actor", principal: v.principal, subject, userId: ident?.user_id ?? null };
}

export type ActingGate = DriveGate | GateDenial;

/**
 * The caller's gate at `path` of `driveId`, at least `min`. An actor is gated as
 * the account they are linked to (a stranger here → 403); the application as a
 * service principal (viewer ceiling). Every service-principal read is logged.
 */
export async function gateActingCaller(driveId: string, path: string, caller: Exclude<ActingCaller, { kind: "none" | "refused" }>, min: "viewer" | "editor" = "viewer"): Promise<ActingGate> {
  if (caller.kind === "actor") {
    if (!caller.userId) {
      // Known drive or not, the answer must not tell: resolve the drive first so a missing one is still 404.
      if (!getDrive(driveId)) return { denied: true, status: 404, body: { error: "drive not found" } };
      return { denied: true, status: 403, body: { error: "forbidden" } };
    }
    return gateDriveRoleForUser(driveId, path, { min, userId: caller.userId });
  }
  let canonical: string;
  try { canonical = normalizePath(path); } catch { return { denied: true, status: 400, body: { error: "invalid path" } }; }
  const drive = getDrive(driveId);
  if (!drive) return { denied: true, status: 404, body: { error: "drive not found" } };
  const role = serviceRoleInDrive(driveId, caller.principal);
  if (role === "none" || min !== "viewer") return { denied: true, status: 403, body: { error: "forbidden" } };
  if (readDenial(driveId, canonical, role, null)?.kind === "payment") return { denied: true, status: 402, body: { error: "payment required" } };
  logServiceRead(caller.principal, driveId, canonical, `${min} gate (ainui)`);
  return { drive, role, userId: null, service: caller.principal };
}
