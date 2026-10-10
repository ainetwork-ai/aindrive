/**
 * GET /api/oauth/events?cursor= — the change feed of an account-grant token's
 * user (`aind_aat_…` with `drives:read`), in the cross-product event contract
 * (lib/share-events.ts). Same rows as /api/me/events; CORS + rate limit as
 * /api/oauth/shared. Consumers (ainteams, ainmem, AINA, …) poll it — every 30 s
 * is plenty — and re-list `/api/oauth/shared` when a page says `gap: true`.
 *
 * Errors are contract bodies: 401 auth_required (with an RFC 6750
 * WWW-Authenticate), 403 forbidden (scope), 429 rate_limited (Retry-After),
 * 415 unsupported_input, 503 temporary_failure.
 */
import { tryConsume, clientKey } from "@/lib/rate-limit";
import { ACCOUNT_API_HEADERS, verifyAccountToken } from "@/lib/account-tokens";
import { errorResponse } from "@/lib/shared-items";
import { listShareEvents, parseEventsQuery } from "@/lib/share-events";

const HEADERS = {
  ...ACCOUNT_API_HEADERS,
  "Access-Control-Expose-Headers": "WWW-Authenticate, Retry-After",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: HEADERS });
}

export function GET(req: Request) {
  const rl = tryConsume({ name: "oauth-events", key: clientKey(req, "oauth-events"), limit: 120, windowMs: 60 * 1000 });
  if (!rl.ok) {
    return errorResponse("rate_limited", "too many requests", { headers: HEADERS, retryAfterSeconds: Math.max(1, Math.ceil(rl.retryAfterMs / 1000)) });
  }
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
  const token = bearer ? verifyAccountToken(bearer) : null;
  if (!token) {
    const description = bearer ? "token is invalid, expired or revoked" : "missing bearer token";
    return errorResponse("auth_required", description, {
      headers: { ...HEADERS, "WWW-Authenticate": `Bearer error="invalid_token", error_description="${description}"` },
    });
  }
  if (!token.scopes.includes("drives:read")) {
    const description = "this endpoint needs the drives:read scope";
    return errorResponse("forbidden", description, {
      headers: { ...HEADERS, "WWW-Authenticate": `Bearer error="insufficient_scope", error_description="${description}", scope="drives:read"` },
    });
  }
  const parsed = parseEventsQuery(new URL(req.url));
  if (!parsed.ok) return errorResponse("unsupported_input", parsed.message, { headers: HEADERS });
  try {
    return Response.json(listShareEvents(token.userId, parsed.cursor), { headers: HEADERS });
  } catch (e) {
    console.error("[oauth/events] feed read failed", e);
    return errorResponse("temporary_failure", "could not read the change feed right now", { headers: HEADERS });
  }
}
