/**
 * Provisioning adapter, protocol ain-sso.adapter.v1 (AIN SSO
 * docs/specs/adapter-protocol.md), mounted at `{AINDRIVE_PUBLIC_URL}/api/sso`:
 *
 *   GET  /v1/health                   liveness, no auth
 *   PUT  /v1/orgs/:orgId/users/:sub   apply a DesiredUserState (versioned, idempotent)
 *   GET  /v1/orgs/:orgId/users/:sub   the applied state, for reconciliation
 *
 * Every non-health request is verified (lib/sso/tokens.ts) before anything
 * is read or written; the apply (lib/sso/store.js applyDesiredState) is one
 * SQLite transaction that ends sessions and revokes the org's credentials
 * before we answer 200. All endpoints answer 404 while AINDRIVE_SSO_ISSUER /
 * AINDRIVE_SSO_CLIENT_ID are unset.
 */
import type { JWTVerifyGetKey } from "jose";
import { adapterConfig, publicBase } from "./config";
import { adapterJwksUrl, remoteJwks } from "./oidc";
import { verifyAdapterRequest } from "./tokens";
import { AdapterError, applyDesiredState, disconnectUserSockets, getAppliedState } from "./store.js";
import { revalidateOrgDrives } from "../orgs.js";

export const ADAPTER_SCHEMA_V1 = "ain-sso.adapter.v1";
const MAX_BODY = 64 * 1024;

type Deps = { keys?: JWTVerifyGetKey; now?: Date };

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
}

function errorResponse(err: AdapterError): Response {
  const extra: Record<string, string> = err.status === 401 ? { "www-authenticate": 'Bearer error="invalid_token"' } : {};
  return json(err.status, { error: err.code, message: err.message, retryable: err.retryable }, extra);
}

const notFound = () => json(404, { error: "not_found", retryable: false });

async function readBody(req: Request): Promise<Uint8Array> {
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY) throw new AdapterError("payload_too_large", 413, "Body too large.", false);
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => {});
      throw new AdapterError("payload_too_large", 413, "Body too large.", false);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

export function handleAdapterHealth(req: Request): Response {
  if (!adapterConfig()) return notFound();
  if (req.method !== "GET" && req.method !== "HEAD") return json(405, { error: "method_not_allowed", retryable: false }, { allow: "GET" });
  return json(200, { status: "ok", schema: ADAPTER_SCHEMA_V1 });
}

export async function handleAdapterUser(req: Request, orgId: string, sub: string, deps: Deps = {}): Promise<Response> {
  const cfg = adapterConfig();
  if (!cfg) return notFound();
  try {
    // htu is compared with the PUBLIC adapter URL (we sit behind a TLS-terminating proxy).
    const expectedUrl = `${new URL(publicBase()).origin}${new URL(req.url).pathname}`;
    const common = {
      method: req.method,
      expectedUrl,
      authorization: req.headers.get("authorization"),
      issuer: cfg.issuer,
      audience: cfg.clientId,
      keys: deps.keys ?? remoteJwks(adapterJwksUrl(cfg.issuer)),
      now: deps.now,
    };
    if (req.method === "GET") {
      await verifyAdapterRequest({ ...common, body: null });
      return json(200, getAppliedState(cfg.issuer, orgId, sub) ?? { exists: false, localUserId: null, appliedVersion: null, status: null, appRole: null, groups: [] });
    }
    if (req.method === "PUT") {
      const body = await readBody(req);
      const { state } = await verifyAdapterRequest({ ...common, body });
      if (!state) throw new AdapterError("invalid_request", 400, "A DesiredUserState body is required.", false);
      if (state.sub !== sub || state.org.id !== orgId) throw new AdapterError("invalid_request", 400, "Body does not match the request path.", false);
      const { result, endedUserIds, unlinkedUserIds, orgIds } = applyDesiredState(cfg.issuer, state);
      for (const userId of new Set([...endedUserIds, ...unlinkedUserIds])) disconnectUserSockets({ userId });
      // Org drives (lib/orgs.js) read the membership on every check; open
      // editors on them are re-checked too (e.g. their creator was suspended),
      // for every organization this push moved (a rolled-back mapping moves
      // the subject's other organizations along).
      for (const o of orgIds) revalidateOrgDrives(cfg.issuer, o);
      return json(200, result);
    }
    return json(405, { error: "method_not_allowed", retryable: false }, { allow: "GET, PUT" });
  } catch (err) {
    if (err instanceof AdapterError) return errorResponse(err);
    console.error("[sso] adapter error:", (err as Error).message);
    return json(500, { error: "adapter_error", message: "Internal adapter error.", retryable: true });
  }
}
