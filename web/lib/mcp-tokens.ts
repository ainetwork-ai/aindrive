/**
 * Remote-MCP bearer tokens — single source for issuing, verifying, listing
 * and revoking the tokens that authenticate `/mcp/d/[driveId]`.
 *
 * Two kinds share one table (`mcp_tokens`, see lib/db.js):
 *   - pat   — issued by hand from the drive's MCP modal (`aind_pat_…`).
 *   - oauth — issued by /api/oauth/token to a connected app: an access token
 *             (`aind_oat_…`, 1h) + refresh token (`aind_ort_…`, 30d), rotated
 *             in place on every refresh so one row = one connected app.
 *
 * Only sha256 hashes are persisted; the raw token is returned exactly once.
 * A token is bound to ONE drive and a scope. The scope is a ceiling, not a
 * grant: every tool call still resolves the user's live role (see
 * shared/agent-skills.ts), so leaving the drive or being downgraded shrinks
 * what a token can do immediately.
 */
import { createHash, randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { db } from "./db";
import { env } from "./env";
import { ROLE_RANK, type Role } from "./access";

export type McpScope = "read" | "write";
export type McpTokenKind = "pat" | "oauth";

export type McpTokenRow = {
  id: string;
  user_id: string;
  drive_id: string;
  name: string;
  scope: McpScope;
  kind: McpTokenKind;
  client_id: string | null;
  expires_at: number | null;
  refresh_expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
  created_at: number;
};

export type VerifiedToken = { id: string; userId: string; driveId: string; scope: McpScope };

export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LAST_USED_THROTTLE_MS = 60 * 1000;

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function mint(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function isMcpScope(s: unknown): s is McpScope {
  return s === "read" || s === "write";
}

/** Public MCP URL for a drive — also the OAuth `resource` identifier. */
export function mcpUrlFor(driveId: string): string {
  return `${env.publicUrl.replace(/\/$/, "")}/mcp/d/${driveId}`;
}

/**
 * Highest role the user holds anywhere in the drive (owner, or the best
 * drive_members grant at any path). Decides the scope ceiling at issue time:
 * someone who can edit nothing cannot mint a write token.
 */
export function maxRoleInDrive(driveId: string, userId: string): Role | "none" {
  const drive = db.prepare("SELECT owner_id FROM drives WHERE id = ?").get(driveId) as
    | { owner_id: string }
    | undefined;
  if (!drive) return "none";
  if (drive.owner_id === userId) return "owner";
  const rows = db
    .prepare("SELECT role FROM drive_members WHERE drive_id = ? AND user_id = ?")
    .all(driveId, userId) as { role: Role }[];
  let best: Role | "none" = "none";
  for (const r of rows) {
    if (best === "none" || ROLE_RANK[r.role] > ROLE_RANK[best]) best = r.role;
  }
  return best;
}

/** Clamp a requested scope to what the user may hold in this drive. */
export function clampScope(driveId: string, userId: string, wanted: McpScope): McpScope | null {
  const role = maxRoleInDrive(driveId, userId);
  if (role === "none") return null;
  if (wanted === "write" && ROLE_RANK[role] >= ROLE_RANK.editor) return "write";
  return "read";
}

export function issuePat(opts: {
  userId: string;
  driveId: string;
  name: string;
  scope: McpScope;
  ttlDays: number | null;
}): { token: string; row: McpTokenRow } {
  const token = mint("aind_pat");
  const now = Date.now();
  const id = nanoid(12);
  const expiresAt = opts.ttlDays ? now + opts.ttlDays * 24 * 60 * 60 * 1000 : null;
  db.prepare(
    `INSERT INTO mcp_tokens (id, user_id, drive_id, name, scope, kind, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'pat', ?, ?, ?)`,
  ).run(id, opts.userId, opts.driveId, opts.name, opts.scope, hashToken(token), expiresAt, now);
  return { token, row: getToken(id)! };
}

export type OAuthTokenPair = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: McpScope;
};

export function issueOAuthTokens(opts: {
  userId: string;
  driveId: string;
  clientId: string;
  clientName: string;
  scope: McpScope;
}): OAuthTokenPair {
  const access = mint("aind_oat");
  const refresh = mint("aind_ort");
  const now = Date.now();
  db.prepare(
    `INSERT INTO mcp_tokens (id, user_id, drive_id, name, scope, kind, client_id, token_hash, refresh_hash,
                             expires_at, refresh_expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'oauth', ?, ?, ?, ?, ?, ?)`,
  ).run(
    nanoid(12), opts.userId, opts.driveId, opts.clientName, opts.scope, opts.clientId,
    hashToken(access), hashToken(refresh), now + ACCESS_TTL_MS, now + REFRESH_TTL_MS, now,
  );
  return { access_token: access, refresh_token: refresh, expires_in: ACCESS_TTL_MS / 1000, scope: opts.scope };
}

/**
 * Refresh-token grant: rotate both tokens in place. The presented refresh
 * token stops working immediately (its hash moves to prev_refresh_hash).
 * Presenting that superseded token again means it leaked — someone else
 * already rotated — so the whole grant is revoked (OAuth 2.1 §4.3.1).
 */
export function refreshOAuthTokens(refreshToken: string, clientId: string): OAuthTokenPair | null {
  const presented = hashToken(refreshToken);
  const reused = db
    .prepare("UPDATE mcp_tokens SET revoked_at = ? WHERE prev_refresh_hash = ? AND kind = 'oauth' AND revoked_at IS NULL")
    .run(Date.now(), presented);
  if (reused.changes > 0) return null;
  const row = db
    .prepare(
      `SELECT id, scope, client_id, refresh_expires_at, revoked_at FROM mcp_tokens
       WHERE refresh_hash = ? AND kind = 'oauth'`,
    )
    .get(presented) as
    | { id: string; scope: McpScope; client_id: string; refresh_expires_at: number; revoked_at: number | null }
    | undefined;
  const now = Date.now();
  if (!row || row.revoked_at || row.client_id !== clientId || row.refresh_expires_at < now) return null;
  const access = mint("aind_oat");
  const refresh = mint("aind_ort");
  const res = db
    .prepare(
      `UPDATE mcp_tokens SET token_hash = ?, refresh_hash = ?, prev_refresh_hash = refresh_hash,
                             expires_at = ?, refresh_expires_at = ?
       WHERE id = ? AND refresh_hash = ?`,
    )
    .run(hashToken(access), hashToken(refresh), now + ACCESS_TTL_MS, now + REFRESH_TTL_MS, row.id, presented);
  if (res.changes !== 1) return null; // lost a concurrent refresh race
  return { access_token: access, refresh_token: refresh, expires_in: ACCESS_TTL_MS / 1000, scope: row.scope };
}

/** Resolve a raw bearer token → its binding, or null if unknown/expired/revoked. */
export function verifyMcpToken(raw: string): VerifiedToken | null {
  if (!raw.startsWith("aind_pat_") && !raw.startsWith("aind_oat_")) return null;
  const row = db
    .prepare(
      `SELECT id, user_id, drive_id, scope, expires_at, revoked_at, last_used_at FROM mcp_tokens
       WHERE token_hash = ?`,
    )
    .get(hashToken(raw)) as
    | (Pick<McpTokenRow, "id" | "user_id" | "drive_id" | "scope" | "expires_at" | "revoked_at" | "last_used_at">)
    | undefined;
  const now = Date.now();
  if (!row || row.revoked_at || (row.expires_at !== null && row.expires_at < now)) return null;
  if (!row.last_used_at || now - row.last_used_at > LAST_USED_THROTTLE_MS) {
    db.prepare("UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?").run(now, row.id);
  }
  return { id: row.id, userId: row.user_id, driveId: row.drive_id, scope: row.scope };
}

const LIST_COLS = `t.id, t.user_id, t.drive_id, t.name, t.scope, t.kind, t.client_id, t.expires_at,
  t.refresh_expires_at, t.last_used_at, t.revoked_at, t.created_at`;

export function getToken(id: string): McpTokenRow | null {
  return (db.prepare(`SELECT ${LIST_COLS} FROM mcp_tokens t WHERE t.id = ?`).get(id) as McpTokenRow) ?? null;
}

/**
 * Active (non-revoked, not fully expired) tokens in a drive. `userId` null =
 * every user's (owner audit view); rows carry the holder's email.
 */
export function listActiveTokens(driveId: string, userId: string | null): (McpTokenRow & { user_email: string | null })[] {
  const now = Date.now();
  const rows = db
    .prepare(
      `SELECT ${LIST_COLS}, u.email AS user_email FROM mcp_tokens t LEFT JOIN users u ON u.id = t.user_id
       WHERE t.drive_id = ? AND t.revoked_at IS NULL ${userId ? "AND t.user_id = ?" : ""}
       ORDER BY t.created_at DESC`,
    )
    .all(...(userId ? [driveId, userId] : [driveId])) as (McpTokenRow & { user_email: string | null })[];
  // An oauth row stays usable while its refresh token lives; a pat while it lives.
  return rows.filter((r) => {
    const until = r.kind === "oauth" ? r.refresh_expires_at : r.expires_at;
    return until === null || until > now;
  });
}

export function revokeToken(id: string): boolean {
  return db.prepare("UPDATE mcp_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(Date.now(), id).changes === 1;
}
