/**
 * Change feed — the contract face of lib/share-events-core.js (ain-integration
 * plan task 10, docs/10-change-propagation.md §1 aindrive row).
 *
 * The contract (packages/contracts/src/events.ts: `ResourceEvent`, `EventPage`)
 * is re-declared here on purpose — no cross-repo import — as the wire shape the
 * routes `GET /api/me/events` (session) and `GET /api/oauth/events` (account
 * grant, `drives:read`) return:
 *
 *   { contract: "1.0", events: [{ kind: "file", type, eventId, resourceId,
 *     version, occurredAt, revision?, recipient }], nextCursor, gap }
 *
 * `eventId` is `evt_<seq>`, `nextCursor` is `ev_<seq>` of the last event of the
 * page (the cursor sent back when nothing is new), a page holds at most
 * EVENT_PAGE_LIMIT events. `gap: true` when the cursor is malformed or below
 * the recipient's retention floor (the newest RETENTION_PER_RECIPIENT rows are
 * kept): the consumer re-lists (`/api/me/shared`) and continues from
 * `nextCursor`. `resourceId` is the shared-file list's key
 * (`<origin>#<driveId>#<fileId>`), so a `file.shared` matches a listed ref.
 *
 * What is recorded, and by whom (lib/share-events-core.js hooks):
 *   file.shared        a grant reached the recipient — members POST (registered
 *                      invitee), share-link accept, paid settle, invite claim
 *                      on signup, an SSO placeholder's grants moving to the person
 *   file.revoked       the recipient's grant went — members DELETE, leave
 *   file.deleted       the drive was deleted (root key, every member) — or the
 *                      device reported a path that no longer exists
 *   file.updated       the device reported a change at a path that exists
 *   file.availability  the drive's agent came online / went offline (root key,
 *                      creator + members; `revision` = "online" | "offline")
 * A share LINK being revoked records nothing: a link is not a grant, and the
 * access already granted through it stays (lib/sales.ts revokeShare).
 * Events never carry a token, a signed URL or a secret.
 */
import { z } from "zod";
import {
  FILE_EVENT_TYPES,
  RETENTION_PER_RECIPIENT,
  prunedTo,
  readEventsAfter,
  latestSeq,
} from "./share-events-core.js";

export {
  FILE_EVENT_TYPES,
  RETENTION_PER_RECIPIENT,
  recordShareEvent,
  resourceKey,
  driveAudience,
  onMemberGranted,
  onMemberRevoked,
  onDriveDeleted,
  onAgentOnlineChanged,
  onFsChanged,
} from "./share-events-core.js";

// ── Contract (mirror of packages/contracts/src/events.ts + common.ts, 1.0) ───

export const CONTRACT_VERSION = "1.0" as const;
export const EVENT_PAGE_LIMIT = 500;

const opaqueId = z.string().min(1).max(256).regex(/^[^\s/\\]+$/);
const instant = z.string().datetime({ offset: true });

export const fileEventType = z.enum(["file.shared", "file.updated", "file.renamed", "file.moved", "file.deleted", "file.revoked", "file.availability"]);
export type FileEventType = z.infer<typeof fileEventType>;

export const fileEventSchema = z.object({
  kind: z.literal("file"),
  type: fileEventType,
  eventId: opaqueId,
  resourceId: z.string().min(1).max(1024),
  version: z.number().int().nonnegative(),
  occurredAt: instant,
  recipient: opaqueId.optional(),
  revision: z.string().max(128).optional(),
}).strict();
export type FileEvent = z.infer<typeof fileEventSchema>;

export const agentEventSchema = z.object({
  kind: z.literal("agent"),
  type: z.enum(["agent.published", "agent.updated", "agent.unpublished", "agent.disabled", "agent.moved", "agent.deleted", "agent.revoked"]),
  eventId: opaqueId,
  resourceId: z.string().min(1).max(1024),
  version: z.number().int().nonnegative(),
  occurredAt: instant,
  recipient: opaqueId.optional(),
  releaseId: z.string().max(128).optional(),
}).strict();

export const resourceEventSchema = z.discriminatedUnion("kind", [fileEventSchema, agentEventSchema]);
export type ResourceEvent = z.infer<typeof resourceEventSchema>;

export const eventPageSchema = z.object({
  contract: z.literal(CONTRACT_VERSION),
  events: z.array(resourceEventSchema),
  nextCursor: z.string().min(1).max(4096),
  gap: z.boolean(),
}).strict();
export type EventPage = z.infer<typeof eventPageSchema>;

/** Which event types mean "hide it and stop using cached bytes/context". */
export const REVOKING_TYPES: ReadonlySet<string> = new Set(["file.deleted", "file.revoked", "agent.unpublished", "agent.disabled", "agent.deleted", "agent.revoked"]);

// ── Cursors ──────────────────────────────────────────────────────────────────

const CURSOR_PREFIX = "ev_";
export const encodeEventCursor = (seq: number) => `${CURSOR_PREFIX}${seq}`;

/** `ev_<seq>` → seq; `null` for anything else (a malformed cursor). No cursor at all is 0. */
export function decodeEventCursor(cursor: string | null | undefined): number | null {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  const m = /^ev_(\d{1,15})$/.exec(cursor);
  return m ? Number(m[1]) : null;
}

// ── Reading ──────────────────────────────────────────────────────────────────

type Row = { seq: number; resource_key: string; drive_id: string; path: string; type: string; version: number; revision: string | null; occurred_at: string };

function toEvent(r: Row, recipient: string): FileEvent {
  return {
    kind: "file",
    type: r.type as FileEventType,
    eventId: `evt_${r.seq}`,
    resourceId: r.resource_key,
    version: r.version,
    occurredAt: r.occurred_at,
    ...(r.revision ? { revision: r.revision } : {}),
    recipient,
  };
}

/**
 * The events addressed to `userId` after `cursor`, oldest first. A cursor that
 * is malformed, older than the retention floor, or AHEAD of anything this feed
 * has issued (a cursor kept across a database restore or a fresh install)
 * answers from the floor with `gap: true`; the consumer re-lists and keeps
 * polling from `nextCursor`. Pure DB reads; never contacts an agent.
 */
export function listShareEvents(userId: string, cursor?: string | null, limit = EVENT_PAGE_LIMIT): EventPage {
  const max = Math.min(EVENT_PAGE_LIMIT, Math.max(1, Math.floor(limit) || EVENT_PAGE_LIMIT));
  const floor = prunedTo(userId);
  const decoded = decodeEventCursor(cursor);
  const issued = latestSeq();
  const ahead = decoded !== null && decoded > issued;
  const gap = decoded === null || decoded < floor || ahead;
  const after = decoded === null || ahead ? floor : Math.max(decoded, floor);
  const rows = readEventsAfter(userId, after, max) as Row[];
  const last = rows.length ? rows[rows.length - 1].seq : after;
  return { contract: CONTRACT_VERSION, events: rows.map((r) => toEvent(r, userId)), nextCursor: encodeEventCursor(last), gap };
}

/** Parse `?cursor=` of a feed request — the same rule for the session and the token route. */
export function parseEventsQuery(url: URL): { ok: true; cursor: string | undefined } | { ok: false; message: string } {
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (cursor !== undefined && cursor.length > 4096) return { ok: false, message: "invalid cursor" };
  return { ok: true, cursor };
}

/** Validate a document against the local mirror of the contract (used by the fixture test and by consumers in-repo). */
export function parseEventPage(doc: unknown): EventPage | null {
  const r = eventPageSchema.safeParse(doc);
  return r.success ? r.data : null;
}
