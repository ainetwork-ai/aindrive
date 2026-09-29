/**
 * GET /api/me/events?cursor= — the signed-in account's change feed in the
 * cross-product event contract (lib/share-events.ts):
 * `{ contract: "1.0", events: [{ kind: "file", type, eventId, resourceId, version, occurredAt, revision?, recipient }], nextCursor, gap }`.
 *
 * At most 500 events per page, oldest first; poll again from `nextCursor`
 * (`ev_<seq>`). `gap: true` (a malformed cursor, or one older than the
 * retention floor of 10 000 events) means: re-list `/api/me/shared` and
 * continue from `nextCursor`. Events are hints — every read re-checks the grant.
 *
 * Cookie session, as /api/me/shared. Errors are contract bodies: 401
 * auth_required, 415 unsupported_input, 503 temporary_failure.
 */
import { getUser } from "@/lib/session";
import { errorResponse, requestOrigin } from "@/lib/shared-items";
import { listShareEvents, parseEventsQuery } from "@/lib/share-events";

export async function GET(req: Request) {
  const user = await getUser();
  if (!user) return errorResponse("auth_required", "sign in to read your change feed", { actionUrl: `${requestOrigin(req)}/login` });
  const parsed = parseEventsQuery(new URL(req.url));
  if (!parsed.ok) return errorResponse("unsupported_input", parsed.message);
  try {
    return Response.json(listShareEvents(user.id, parsed.cursor), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[me/events] feed read failed", e);
    return errorResponse("temporary_failure", "could not read the change feed right now");
  }
}
