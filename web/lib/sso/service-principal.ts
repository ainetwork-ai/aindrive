/**
 * Service principals: a first-party AIN application acting as ITSELF (not for
 * a signed-in person), with a machine token from AIN SSO (OAuth 2.0
 * `client_credentials`, RFC 8707 resource indicator, RFC 9068 JWT; AIN SSO
 * architecture §4.9). Today: ainize-node cloning a drive repository when a
 * push hook fires (docs/PERMISSIONS.md "Organizations", ainize-node
 * docs/PROJECTS.md).
 *
 * The token (`Authorization: Bearer <at+jwt>`) must be signed by the issuer
 * (`AINDRIVE_SSO_ISSUER`, keys from its JWKS), name THIS aindrive as its
 * audience (`aud` = `AINDRIVE_PUBLIC_URL`), be unexpired, and its `sub` (=
 * `azp` = `client_id`) must be an application the operator trusts
 * (`AINDRIVE_SSO_SERVICE_APPS`, comma-separated client_ids). Anything else is
 * a 401 — never a fall-through to another credential.
 *
 * What a service principal may do: READ, as a viewer, the drives shared with
 * an organization the application is assigned in (the token's `orgs` claim —
 * AIN SSO's app-assignment rule, carried in the token because aindrive has no
 * server-to-server lookup of assignments) while that share is in force (the
 * drive's creator is still an active member, like lib/orgs.js). Nothing else:
 * no owner/editor, no `.aindrive/`, no write (receive-pack is refused), and
 * only the routes that opt in (`requireDriveRole(..., { service: true })`:
 * git upload-pack over both URL shapes, git-meta). Every read is logged.
 */
import { decodeProtectedHeader, errors as joseErrors, jwtVerify, type JWTPayload } from "jose";
import { db } from "../db";
import { log } from "../logger.js";
import { adapterConfig, publicBase } from "./config";
import { adapterJwksUrl, remoteJwks, SSO_ALGORITHMS } from "./oidc";

export const SERVICE_TOKEN_TYPE = "at+jwt";
const CLOCK_TOLERANCE = 5;

export type ServicePrincipal = { clientId: string; orgs: string[]; jti: string | null; exp: number | null };
export type ServiceTokenResult = { ok: true; principal: ServicePrincipal } | { ok: false; reason: string };

/** Trusted first-party application client_ids (read per call: a restart applies a change). */
export function serviceApps(): string[] {
  return (process.env.AINDRIVE_SSO_SERVICE_APPS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** `Authorization: Bearer <token>` of a request, or null. */
export function bearerOf(req: Request): string | null {
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec((req.headers.get("authorization") ?? "").trim());
  return m ? m[1] : null;
}

/**
 * Whether a bearer is (shaped like) an AIN SSO machine token: a JWT whose
 * header says `typ: at+jwt` with an asymmetric algorithm. Session JWTs (HS256,
 * no typ), account tokens (`aind_aat_…`) and delegations (`ain-rdlg+jwt`) are
 * not, so they keep their own paths. Shape only — verification is separate.
 */
export function isServiceToken(token: string | null): boolean {
  if (!token || token.split(".").length !== 3) return false;
  try {
    const h = decodeProtectedHeader(token);
    return h.typ === SERVICE_TOKEN_TYPE && typeof h.alg === "string" && SSO_ALGORITHMS.includes(h.alg);
  } catch { return false; }
}

/** Verifies a machine token against the issuer's JWKS and the trust list. Never throws. */
export async function verifyServiceToken(token: string, deps: { now?: Date } = {}): Promise<ServiceTokenResult> {
  const cfg = adapterConfig();
  if (!cfg) return { ok: false, reason: "sso_off" };
  const trusted = serviceApps();
  if (trusted.length === 0) return { ok: false, reason: "no_service_apps" };
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, remoteJwks(adapterJwksUrl(cfg.issuer)), {
      issuer: cfg.issuer,
      audience: publicBase(),
      typ: SERVICE_TOKEN_TYPE,
      algorithms: SSO_ALGORITHMS,
      clockTolerance: CLOCK_TOLERANCE,
      currentDate: deps.now,
      requiredClaims: ["sub", "exp", "iat"],
    }));
  } catch (e) {
    if (e instanceof joseErrors.JWTExpired) return { ok: false, reason: "expired" };
    if (e instanceof joseErrors.JWTClaimValidationFailed) return { ok: false, reason: `claim:${e.claim}` };
    if (e instanceof joseErrors.JOSEError) return { ok: false, reason: e.code.toLowerCase() };
    return { ok: false, reason: "unverifiable" };
  }
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  const azp = typeof payload.azp === "string" ? payload.azp : sub;
  const clientId = typeof payload.client_id === "string" ? payload.client_id : sub;
  // A machine token stands for the application and nobody else: sub, azp and client_id agree.
  if (!sub || azp !== sub || clientId !== sub) return { ok: false, reason: "not_a_service_token" };
  if (!trusted.includes(sub)) return { ok: false, reason: "untrusted_app" };
  const orgs = Array.isArray(payload.orgs) ? payload.orgs.filter((o): o is string => typeof o === "string" && o.length > 0) : [];
  return { ok: true, principal: { clientId: sub, orgs, jti: typeof payload.jti === "string" ? payload.jti : null, exp: payload.exp ?? null } };
}

/**
 * The role a service principal holds in a drive: `viewer` when the drive is
 * shared (drive_org_shares, this issuer) with one of the token's organizations
 * and that share is in force — the drive's creator is still an active member
 * of it (the same rule lib/orgs.js applies to people). Else `none`.
 */
export function serviceRoleInDrive(driveId: string, principal: ServicePrincipal): "viewer" | "none" {
  const cfg = adapterConfig();
  if (!cfg || principal.orgs.length === 0) return "none";
  const marks = principal.orgs.map(() => "?").join(",");
  const row = db.prepare(
    `SELECT 1 FROM drive_org_shares s JOIN drives d ON d.id = s.drive_id
     WHERE s.drive_id = ? AND s.issuer = ? AND s.org_id IN (${marks})
       AND EXISTS (SELECT 1 FROM sso_memberships ma WHERE ma.issuer = s.issuer AND ma.org_id = s.org_id AND ma.user_id = d.owner_id AND ma.status = 'active')
       AND NOT EXISTS (SELECT 1 FROM sso_memberships mb WHERE mb.issuer = s.issuer AND mb.org_id = s.org_id AND mb.user_id = d.owner_id AND mb.status != 'active')
     LIMIT 1`,
  ).get(driveId, cfg.issuer, ...principal.orgs);
  return row ? "viewer" : "none";
}

/** Every service-principal read is logged (who, where, what). */
export function logServiceRead(principal: ServicePrincipal, driveId: string, path: string, what: string) {
  log.info({ ns: "aindrive.service-principal", clientId: principal.clientId, driveId, path, what, jti: principal.jti }, "service principal read");
}
