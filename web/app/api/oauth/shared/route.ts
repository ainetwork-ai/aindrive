/**
 * GET /api/oauth/shared?scope=&q=&cursor=&limit=&org= — the files an
 * account-grant token's user can reach (`aind_aat_…` with `drives:read`), in
 * the cross-product list contract (lib/shared-items.ts). Same rows as
 * /api/me/shared; CORS + rate limit as /api/oauth/drives.
 *
 * Errors are contract bodies: 401 auth_required (with an RFC 6750
 * WWW-Authenticate), 403 forbidden (scope), 429 rate_limited (Retry-After),
 * 415 unsupported_input, 503 temporary_failure.
 *
 * With AIN_INTEGRATION_ENABLED every answer carries `X-Request-Id` and is
 * logged once (lib/request-id.ts: never the bearer token).
 */
import { tryConsume, clientKey } from "@/lib/rate-limit";
import { ACCOUNT_API_HEADERS, verifyAccountToken } from "@/lib/account-tokens";
import { errorResponse, listSharedItems, parseListQuery, requestOrigin, sharedScopeHeaders } from "@/lib/shared-items";
import { contractErrorOf, logRoute, requestIdOf, scrubSecrets, withRequestId, REQUEST_ID_HEADER } from "@/lib/request-id";

const HEADERS = {
  ...ACCOUNT_API_HEADERS,
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-Id",
  "Access-Control-Expose-Headers": `WWW-Authenticate, Retry-After, X-AIN-Scope-Unsupported, X-AIN-Scope-Fallback, ${REQUEST_ID_HEADER}`,
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: HEADERS });
}

export async function GET(req: Request) {
  const requestId = requestIdOf(req);
  let userId: string | null = null;
  const done = async (res: Response, error?: unknown) => {
    logRoute({ requestId, route: "oauth/shared", status: res.status, ...(await contractErrorOf(res)), userId, auth: userId ? "account_token" : "anonymous", error });
    return withRequestId(res, requestId);
  };
  const rl = tryConsume({ name: "oauth-shared", key: clientKey(req, "oauth-shared"), limit: 120, windowMs: 60 * 1000 });
  if (!rl.ok) {
    return done(errorResponse("rate_limited", "too many requests", { headers: HEADERS, retryAfterSeconds: Math.max(1, Math.ceil(rl.retryAfterMs / 1000)) }));
  }
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
  const token = bearer ? verifyAccountToken(bearer) : null;
  if (!token) {
    const description = bearer ? "token is invalid, expired or revoked" : "missing bearer token";
    return done(errorResponse("auth_required", description, {
      headers: { ...HEADERS, "WWW-Authenticate": `Bearer error="invalid_token", error_description="${description}"` },
    }));
  }
  userId = token.userId;
  if (!token.scopes.includes("drives:read")) {
    const description = "this endpoint needs the drives:read scope";
    return done(errorResponse("forbidden", description, {
      headers: { ...HEADERS, "WWW-Authenticate": `Bearer error="insufficient_scope", error_description="${description}", scope="drives:read"` },
    }));
  }
  const parsed = parseListQuery(new URL(req.url));
  if (!parsed.ok) return done(errorResponse("unsupported_input", parsed.message, { headers: HEADERS }));
  try {
    const body = listSharedItems(token.userId, { ...parsed.opts, origin: requestOrigin(req) });
    return done(Response.json(body, { headers: { ...HEADERS, ...sharedScopeHeaders(parsed.opts.scope, parsed.opts.org) } }));
  } catch (e) {
    console.error("[oauth/shared] listing failed", scrubSecrets(String((e as Error)?.message ?? e)));
    return done(errorResponse("temporary_failure", "could not list shared files right now", { headers: HEADERS }), e);
  }
}
