/**
 * GET /api/me/shared?scope=&q=&cursor=&limit=&org= — the signed-in account's
 * reachable files in the cross-product list contract (lib/shared-items.ts):
 * `{ contract: "1.0", asOf, nextCursor, items: [{ ref, role, shareOrigin, paid?, sharedAt? }] }`.
 *
 * Cookie session, as /api/me/tier. Errors are contract bodies
 * (`{ error: { code, message, retryable } }`): 401 auth_required, 415
 * unsupported_input for a malformed query, 503 temporary_failure. A scope this
 * server only approximates is flagged in `X-AIN-Scope-Unsupported` /
 * `X-AIN-Scope-Fallback` (shared_with_org, recent).
 */
import { getUser } from "@/lib/session";
import { errorResponse, listSharedItems, parseListQuery, requestOrigin, sharedScopeHeaders } from "@/lib/shared-items";

export async function GET(req: Request) {
  const user = await getUser();
  if (!user) return errorResponse("auth_required", "sign in to list your shared files", { actionUrl: `${requestOrigin(req)}/login` });
  const parsed = parseListQuery(new URL(req.url));
  if (!parsed.ok) return errorResponse("unsupported_input", parsed.message);
  try {
    const body = listSharedItems(user.id, { ...parsed.opts, origin: requestOrigin(req) });
    return Response.json(body, { headers: { "Cache-Control": "no-store", ...sharedScopeHeaders(parsed.opts.scope, parsed.opts.org) } });
  } catch (e) {
    console.error("[me/shared] listing failed", e);
    return errorResponse("temporary_failure", "could not list shared files right now");
  }
}
