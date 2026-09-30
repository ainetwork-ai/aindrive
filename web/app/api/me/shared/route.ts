/**
 * GET /api/me/shared?scope=&q=&cursor=&limit=&org= — the signed-in account's
 * reachable files in the cross-product list contract (lib/shared-items.ts):
 * `{ contract: "1.0", asOf, nextCursor, items: [{ ref, role, shareOrigin, paid?, sharedAt? }] }`.
 *
 * Cookie session, as /api/me/tier. Errors are contract bodies
 * (`{ error: { code, message, retryable } }`): 401 auth_required, 415
 * unsupported_input for a malformed query, 503 temporary_failure. A scope this
 * server only approximates is flagged in `X-AIN-Scope-Unsupported` (`org=`
 * outside shared_with_org) / `X-AIN-Scope-Fallback` (recent).
 *
 * With AIN_INTEGRATION_ENABLED every answer carries `X-Request-Id` and is
 * logged once (lib/request-id.ts: no cookie, no query string).
 */
import { getUser } from "@/lib/session";
import { errorResponse, listSharedItems, parseListQuery, requestOrigin, sharedScopeHeaders } from "@/lib/shared-items";
import { contractErrorOf, logRoute, requestIdOf, scrubSecrets, withRequestId } from "@/lib/request-id";

export async function GET(req: Request) {
  const requestId = requestIdOf(req);
  let userId: string | null = null;
  const done = async (res: Response, error?: unknown) => {
    logRoute({ requestId, route: "me/shared", status: res.status, ...(await contractErrorOf(res)), userId, auth: userId ? "session" : "anonymous", error });
    return withRequestId(res, requestId);
  };
  const user = await getUser();
  if (!user) return done(errorResponse("auth_required", "sign in to list your shared files", { actionUrl: `${requestOrigin(req)}/login` }));
  userId = user.id;
  const parsed = parseListQuery(new URL(req.url));
  if (!parsed.ok) return done(errorResponse("unsupported_input", parsed.message));
  try {
    const body = listSharedItems(user.id, { ...parsed.opts, origin: requestOrigin(req) });
    return done(Response.json(body, { headers: { "Cache-Control": "no-store", ...sharedScopeHeaders(parsed.opts.scope, parsed.opts.org) } }));
  } catch (e) {
    console.error("[me/shared] listing failed", scrubSecrets(String((e as Error)?.message ?? e)));
    return done(errorResponse("temporary_failure", "could not list shared files right now"), e);
  }
}
