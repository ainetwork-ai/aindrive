/**
 * The common "shared with me" file list (ain-integration plan task 06).
 *
 * One listing, in the cross-product contract shape (packages/contracts:
 * file-ref.ts / list.ts / errors.ts), for every surface that asks "which
 * files can this account reach?": the session UI (/api/me/shared), account
 * grants (/api/oauth/shared) and the agent protocols (skill `list_shared`).
 *
 * The contract is re-declared here on purpose (no cross-repo import): the
 * shapes below are the wire format, and this module is the one place that
 * must be kept in step with packages/contracts.
 *
 * Rows come from aindrive's own tables only (docs/PERMISSIONS_MATRIX.md
 * R-SHARE-LIST-002):
 *   mine            every drive the caller created → its root as a folder ref
 *   shared_with_me  every `drive_members` row of the caller on a drive someone
 *                   else created → one ref per grant path. A pending
 *                   `drive_invites` row is NOT shared yet and never appears.
 *   shared_with_org every drive shared with an organization the caller is an
 *                   ACTIVE member of (`drive_org_shares` × `sso_memberships`,
 *                   lib/orgs.js orgDrivesForUser: in-force shares only) → its
 *                   root as a folder ref with the share's role and
 *                   `shareOrigin: org` (R-SHARE-ORG-001). `org=` keeps one
 *                   organization's rows. The caller's own drives are left out,
 *                   and a suspended membership yields nothing.
 *   recent          nothing records opens today → the shared_with_me list,
 *                   newest grant first; the route says so in a header.
 *
 * A reference never carries a token, signed URL or secret.
 */
import { createHash } from "node:crypto";
import { db } from "./db";
import { env } from "./env";
import { isOnline } from "./rpc";
import { resolveRoleByUser } from "./access";
import { paidLocksForPaths } from "./sale-access.js";
import { orgDrivesForUser } from "./orgs.js";
import { lookupMime } from "./mime";
import { ainIntegrationEnabled } from "./ain-integration.js";
import { generationFor, revisionWithGeneration } from "./path-generations.js";
import { isSystemPath } from "@/shared/domain/policy/system-paths";

// ── Contract (mirror of packages/contracts/src, version 1.0) ─────────────────

export const CONTRACT_VERSION = "1.0" as const;

export type FileKind = "file" | "folder";
export type AvailabilityState = "online" | "offline" | "deleted" | "unknown";
export type OwnerRef = { kind: "account" | "org" | "wallet" | "principal"; issuer: string; subject: string; displayName?: string };

export type FileRef = {
  contract: typeof CONTRACT_VERSION;
  issuer: string;
  driveId: string;
  fileId: string;
  revision: string;
  kind: FileKind;
  mimeType?: string;
  displayName: string;
  ownerRef: OwnerRef;
  availability: { state: AvailabilityState; lastSeenAt?: string };
  sourceUrl?: string;
  legacy?: { path: string };
  size?: number;
  sha256?: string;
};

export type FileAccessRole = "owner" | "editor" | "viewer" | "none";
export type ShareOrigin = "own" | "direct" | "org" | "link" | "paid";

export type FileListItem = {
  ref: FileRef;
  role: FileAccessRole;
  shareOrigin: ShareOrigin;
  paid?: { entitled: boolean; pricingRef?: string };
  modifiedAt?: string;
  sharedAt?: string;
};

export const FILE_LIST_SCOPES = ["mine", "shared_with_me", "shared_with_org", "recent"] as const;
export type FileListScope = (typeof FILE_LIST_SCOPES)[number];
export const isFileListScope = (s: unknown): s is FileListScope => (FILE_LIST_SCOPES as readonly unknown[]).includes(s);

export type FileListResponse = {
  contract: typeof CONTRACT_VERSION;
  asOf: string;
  nextCursor: string | null;
  cursorExpired?: boolean;
  items: FileListItem[];
};

export type ErrorCode =
  | "auth_required" | "forbidden" | "entitlement_required" | "unsupported_input" | "source_offline"
  | "resource_deleted" | "agent_stopped" | "rate_limited" | "temporary_failure";

export const HTTP_STATUS_FOR: Record<ErrorCode, number> = {
  auth_required: 401, forbidden: 403, entitlement_required: 402, unsupported_input: 415,
  source_offline: 503, resource_deleted: 410, agent_stopped: 409, rate_limited: 429, temporary_failure: 503,
};
export const RETRYABLE: Record<ErrorCode, boolean> = {
  auth_required: false, forbidden: false, entitlement_required: false, unsupported_input: false,
  source_offline: true, resource_deleted: false, agent_stopped: false, rate_limited: true, temporary_failure: true,
};

export type ErrorBody = {
  error: { code: ErrorCode; message: string; retryable: boolean; retryAfterSeconds?: number; actionUrl?: string; detail?: string };
};

export function makeError(code: ErrorCode, message: string, extra: Partial<Omit<ErrorBody["error"], "code" | "message" | "retryable">> = {}): ErrorBody {
  return { error: { code, message, retryable: RETRYABLE[code], ...extra } };
}

/** A contract error as an HTTP response (status from the code; Retry-After for rate limits). */
export function errorResponse(code: ErrorCode, message: string, opts: { headers?: Record<string, string>; retryAfterSeconds?: number; actionUrl?: string } = {}): Response {
  const body = makeError(code, message, {
    ...(opts.retryAfterSeconds ? { retryAfterSeconds: opts.retryAfterSeconds } : {}),
    ...(opts.actionUrl ? { actionUrl: opts.actionUrl } : {}),
  });
  const headers: Record<string, string> = { "Cache-Control": "no-store", ...(opts.headers ?? {}) };
  if (opts.retryAfterSeconds) headers["Retry-After"] = String(opts.retryAfterSeconds);
  return Response.json(body, { status: HTTP_STATUS_FOR[code], headers });
}

// ── Identity (phase A: path-derived ids, packages/contracts adapters.ts) ─────

export const AINDRIVE_PATH_ID_PREFIX = "p1:";

/**
 * The contract's spelling of an aindrive path: forward slashes, no '' or '.'
 * segments, Unicode NFC, letter case kept, and a leading '/' ("/" = the drive
 * root). Identical to `aindriveNormalizePath` in packages/contracts so every
 * product derives the same id from the same file.
 */
export function contractPath(p: string): string {
  const parts = p.replace(/\\/g, "/").normalize("NFC").split("/").filter((s) => s !== "" && s !== ".");
  return "/" + parts.join("/");
}

/** Phase A file id: "p1:" + sha256(driveId + "\0" + contractPath).hex[0..32]. Changes on rename/move. */
export function sharedFileId(driveId: string, path: string): string {
  return AINDRIVE_PATH_ID_PREFIX + createHash("sha256").update(driveId + "\0" + contractPath(path)).digest("hex").slice(0, 32);
}

/** Weak revision until aindrive publishes one: `m<mtimeMs>-s<size>`. */
export const sharedRevision = (e: { mtimeMs?: number | null; size?: number | null }) => `m${e.mtimeMs ?? 0}-s${e.size ?? 0}`;

// ── Listing ──────────────────────────────────────────────────────────────────

export type ListSharedOpts = {
  scope: FileListScope;
  q?: string;
  cursor?: string;
  limit?: number;
  org?: string;
  /** The server's public origin (issuer of every ref). Defaults to AINDRIVE_PUBLIC_URL. */
  origin?: string;
};

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

type DriveRow = { id: string; owner_id: string; name: string; last_seen_at: string | null; created_at: string };
type MemberRow = DriveRow & { path: string; role: FileAccessRole; member_created_at: string };

/** SQLite `datetime('now')` text ("YYYY-MM-DD HH:MM:SS", UTC) or ISO → ISO-8601 instant. */
export function toInstant(s: string | null | undefined): string | undefined {
  if (!s) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(s);
  const d = new Date(m ? `${m[1]}T${m[2]}Z` : s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const originOf = (o?: string) => (o || env.publicUrl).replace(/\/$/, "");

/**
 * Who owns a drive, as the contract names people: the AIN SSO account when the
 * owner has linked one (the configured issuer first, then the oldest link),
 * else this server's own account id.
 */
function ownerRefFor(origin: string, ownerId: string): OwnerRef {
  const preferred = (process.env.AINDRIVE_SSO_ISSUER ?? "").trim();
  const ident = db
    .prepare("SELECT issuer, subject FROM sso_identities WHERE user_id = ? ORDER BY (issuer = ?) DESC, linked_at ASC LIMIT 1")
    .get(ownerId, preferred) as { issuer: string; subject: string } | undefined;
  return ident
    ? { kind: "account", issuer: ident.issuer.replace(/\/$/, ""), subject: ident.subject }
    : { kind: "account", issuer: origin, subject: ownerId };
}

function refFor(origin: string, drive: DriveRow, path: string, ownerRef: OwnerRef): FileRef {
  const cpath = contractPath(path);
  const isRoot = cpath === "/";
  const name = isRoot ? drive.name : cpath.slice(cpath.lastIndexOf("/") + 1);
  // No per-path metadata without the agent: a non-root grant is a folder unless
  // its name carries a known file extension (a share can sell one file).
  const mime = isRoot ? null : lookupMime(name);
  const lastSeenAt = toInstant(drive.last_seen_at);
  const online = isOnline(drive.id);
  // The drive publishes no mtime; its last heartbeat (else creation) stands in.
  let revision = sharedRevision({ mtimeMs: lastSeenAt ? Date.parse(lastSeenAt) : Date.parse(toInstant(drive.created_at) ?? "") || 0, size: 0 });
  // Task 10.2: the path's generation pins the ref to the file there now
  // (fs/read?revision= refuses it once another file takes the path).
  if (ainIntegrationEnabled()) revision = revisionWithGeneration(revision, generationFor(drive.id, cpath.slice(1)));
  return {
    contract: CONTRACT_VERSION,
    issuer: origin,
    driveId: drive.id,
    fileId: sharedFileId(drive.id, cpath),
    revision,
    kind: mime ? "file" : "folder",
    ...(mime ? { mimeType: mime } : {}),
    displayName: name || drive.name,
    ownerRef,
    availability: { state: online ? "online" : "offline", ...(lastSeenAt ? { lastSeenAt } : {}) },
    sourceUrl: `${origin}/d/${encodeURIComponent(drive.id)}${cpath.split("/").map(encodeURIComponent).join("/")}`,
    legacy: { path: cpath },
  };
}

function ownedItems(origin: string, userId: string): FileListItem[] {
  const rows = db
    .prepare("SELECT id, owner_id, name, last_seen_at, created_at FROM drives WHERE owner_id = ? ORDER BY created_at DESC, id")
    .all(userId) as DriveRow[];
  const ownerRef = rows.length ? ownerRefFor(origin, userId) : null;
  return rows.map((d) => ({ ref: refFor(origin, d, "", ownerRef!), role: "owner" as const, shareOrigin: "own" as const }));
}

/**
 * The caller's grant rows on drives they did not create — never a child of a
 * grant (a listing of a folder is the fs/list route's job, with its own
 * per-child locks). Each row is judged at its own path: the role is the best
 * covering grant, and a priced path the caller has not bought is carried with
 * `paid.entitled=false` (R-VIS-PAID-002: the grant is the member's own), so an
 * unlisted sale surfaces only to accounts holding a grant or receipt there.
 */
function memberItems(origin: string, userId: string): FileListItem[] {
  const rows = db
    .prepare(
      `SELECT d.id, d.owner_id, d.name, d.last_seen_at, d.created_at, m.path, m.role, m.created_at AS member_created_at
       FROM drive_members m JOIN drives d ON d.id = m.drive_id
       WHERE m.user_id = ? AND d.owner_id != ?
       ORDER BY m.created_at DESC, d.id, m.path`,
    )
    .all(userId, userId) as MemberRow[];
  if (!rows.length) return [];
  const owners = new Map<string, OwnerRef>();
  const receipts = db
    .prepare("SELECT drive_id, path, share_id FROM payment_receipts WHERE account_id = ?")
    .all(userId) as { drive_id: string; path: string; share_id: string | null }[];
  const receiptAt = new Map(receipts.map((r) => [`${r.drive_id}\0${r.path}`, r] as const));
  const byDrive = new Map<string, MemberRow[]>();
  // A grant row on the reserved `.aindrive/` subtree names nothing the member
  // can open (every route refuses it): never list it (task 06.5).
  for (const r of rows) if (!isSystemPath(r.path)) byDrive.set(r.id, [...(byDrive.get(r.id) ?? []), r]);

  const items: FileListItem[] = [];
  for (const [driveId, grants] of byDrive) {
    const roleAt = (p: string) => resolveRoleByUser(driveId, userId, p);
    const locks = paidLocksForPaths(driveId, grants.map((g) => g.path), roleAt, userId);
    for (const g of grants) {
      if (!owners.has(g.owner_id)) owners.set(g.owner_id, ownerRefFor(origin, g.owner_id));
      const receipt = receiptAt.get(`${driveId}\0${g.path}`);
      const lock = locks[g.path];
      const item: FileListItem = {
        ref: refFor(origin, g, g.path, owners.get(g.owner_id)!),
        role: roleAt(g.path),
        // Membership rows do not record whether an invite or a share link made
        // them, so every unpaid grant is `direct`; a receipt at the path makes it `paid`.
        shareOrigin: receipt ? "paid" : "direct",
      };
      if (receipt) item.paid = { entitled: true, ...(receipt.share_id ? { pricingRef: `share:${receipt.share_id}` } : {}) };
      else if (lock) item.paid = { entitled: false, pricingRef: `share:${lock.shareId}` };
      const sharedAt = toInstant(g.member_created_at);
      if (sharedAt) item.sharedAt = sharedAt;
      items.push(item);
    }
  }
  return items;
}

/**
 * The drives shared with an organization the caller is an active member of
 * (R-SHARE-ORG-001): one root ref per (drive, org), newest share first, with
 * the share's role — a whole-drive grant, so no per-path locks to judge here
 * (a paid subtree is the fs/list route's job, as for a direct root grant).
 * The caller's own drives are never "shared with" them. A share that is not
 * in force (the creator left the org, the adapter is off) is not listed: the
 * caller could not open it (R-ORG-ACC-003).
 */
function orgItems(origin: string, userId: string, org?: string): FileListItem[] {
  const rows = orgDrivesForUser(userId)
    .filter((d) => d.owner_id !== userId && (!org || d.org_id === org))
    .sort((a, b) => b.org_shared_at - a.org_shared_at || a.id.localeCompare(b.id) || a.org_id.localeCompare(b.org_id));
  const owners = new Map<string, OwnerRef>();
  return rows.map((d) => {
    if (!owners.has(d.owner_id)) owners.set(d.owner_id, ownerRefFor(origin, d.owner_id));
    const item: FileListItem = { ref: refFor(origin, d, "", owners.get(d.owner_id)!), role: d.org_role, shareOrigin: "org" };
    const sharedAt = Number.isFinite(d.org_shared_at) ? new Date(d.org_shared_at).toISOString() : undefined;
    if (sharedAt) item.sharedAt = sharedAt;
    return item;
  });
}

const CURSOR_PREFIX = "v1:";
const encodeCursor = (scope: FileListScope, offset: number) => Buffer.from(`${CURSOR_PREFIX}${scope}:${offset}`, "utf8").toString("base64url");
function decodeCursor(scope: FileListScope, cursor: string | undefined): number | null {
  if (!cursor) return 0;
  let text = "";
  try { text = Buffer.from(cursor, "base64url").toString("utf8"); } catch { return null; }
  const m = new RegExp(`^${CURSOR_PREFIX}(${FILE_LIST_SCOPES.join("|")}):(\\d{1,9})$`).exec(text);
  if (!m || m[1] !== scope) return null;
  return Number(m[2]);
}

/**
 * Extra response headers the route sends for a scope this server only
 * approximates: `org=` means nothing outside shared_with_org (an organization
 * never restricts `mine`; a direct grant belongs to no organization), and
 * `recent` is shared_with_me in disguise.
 */
export function sharedScopeHeaders(scope: FileListScope, org?: string): Record<string, string> {
  const h: Record<string, string> = {};
  if (org && scope !== "shared_with_org") h["X-AIN-Scope-Unsupported"] = "org";
  if (scope === "recent") h["X-AIN-Scope-Fallback"] = "recent=shared_with_me";
  return h;
}

/** The files `userId` can reach, in the contract's list shape. Pure DB reads; never contacts an agent. */
export function listSharedItems(userId: string, opts: ListSharedOpts): FileListResponse {
  const origin = originOf(opts.origin);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT));
  const asOf = new Date().toISOString();

  let all: FileListItem[];
  if (opts.scope === "shared_with_org") all = orgItems(origin, userId, opts.org?.trim() || undefined);
  // `org=` restricts nothing but the organization scope: empty, never someone else's rows.
  else if (opts.org) all = [];
  else if (opts.scope === "mine") all = ownedItems(origin, userId);
  else all = memberItems(origin, userId); // shared_with_me, and recent's stand-in

  const q = opts.q?.trim().toLowerCase();
  if (q) all = all.filter((i) => i.ref.displayName.toLowerCase().includes(q) || (i.ref.legacy?.path ?? "").toLowerCase().includes(q));

  const offset = decodeCursor(opts.scope, opts.cursor);
  const expired = offset === null;
  const start = expired ? 0 : offset;
  const page = all.slice(start, start + limit);
  const next = start + limit < all.length ? encodeCursor(opts.scope, start + limit) : null;
  return { contract: CONTRACT_VERSION, asOf, nextCursor: next, ...(expired ? { cursorExpired: true } : {}), items: page };
}

/**
 * Parse the listing query of a request (`scope`, `q`, `cursor`, `limit`, `org`)
 * — the same rules for the session and the token route.
 */
export function parseListQuery(url: URL): { ok: true; opts: ListSharedOpts } | { ok: false; message: string } {
  const scope = url.searchParams.get("scope") ?? "shared_with_me";
  if (!isFileListScope(scope)) return { ok: false, message: `unknown scope "${scope}" (one of ${FILE_LIST_SCOPES.join(", ")})` };
  const q = url.searchParams.get("q") ?? undefined;
  if (q !== undefined && q.length > 200) return { ok: false, message: "q is longer than 200 characters" };
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > 4096)) return { ok: false, message: "invalid cursor" };
  const org = url.searchParams.get("org") ?? undefined;
  if (org !== undefined && org.length > 256) return { ok: false, message: "org is longer than 256 characters" };
  const rawLimit = url.searchParams.get("limit");
  let limit: number | undefined;
  if (rawLimit !== null) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return { ok: false, message: `limit must be an integer from 1 to ${MAX_LIMIT}` };
  }
  return { ok: true, opts: { scope, q, cursor, limit, org } };
}

/** The issuer of every ref this server mints: AINDRIVE_PUBLIC_URL, else the request's own origin. */
export function requestOrigin(req: Request): string {
  if (process.env.AINDRIVE_PUBLIC_URL) return env.publicUrl.replace(/\/$/, "");
  try { return new URL(req.url).origin; } catch { return env.publicUrl.replace(/\/$/, ""); }
}
