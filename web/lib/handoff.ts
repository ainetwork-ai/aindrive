/**
 * File handoff links — how an owner's device hands ONE picked file to an outside agent (A2A).
 *
 * The device picks the files and registers each under a random `device_key` it keeps locally;
 * this module stores a link per file: `/api/h/<id>?k=<secret>` (id + secret, only the secret's
 * hash kept). A fetch of that URL is checked (secret, expiry, revocation), logged, and served by
 * streaming `handoff-read` RPCs from the device through its carrier drive's socket — nothing is
 * cached on the server, and the device serves only keys it registered (so a link can never reach
 * other files, even in the same folder). Owners list and revoke their links (/api/handoffs).
 *
 * A handoff made on the web instead (Folder Chat asking a cloud agent, lib/cloud-agent.ts) names
 * its file by drive path (`drivePath`): the web picked exactly those files, and their bytes come
 * over the download-chunk RPC every agent serves — `readHandoffChunk` hides which kind a row is.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { nanoid } from "nanoid";
import { db } from "./db";
import { callAgent } from "./rpc";

export const MAX_TTL_SECONDS = 60 * 60;
export const DEFAULT_TTL_SECONDS = 15 * 60;
export const MAX_FILES = 20;

export interface HandoffFile { deviceKey: string; name: string; mime: string; size: number; drivePath?: string }
export interface HandoffRow {
  id: string; secret_hash: string; owner_id: string; drive_id: string; device_key: string; name: string; mime: string;
  size: number; audience: string; created_at: string; expires_at: string; revoked_at: string | null; grant_id: string | null;
  drive_path: string | null;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const expiryOf = (ttlSeconds: number) =>
  new Date(Date.now() + Math.max(30, Math.min(MAX_TTL_SECONDS, Math.floor(ttlSeconds))) * 1000).toISOString().replace("T", " ").slice(0, 19);

export function createHandoffs(ownerId: string, driveId: string, files: HandoffFile[], audience: string, ttlSeconds: number, grantId: string | null = null) {
  const expires = expiryOf(ttlSeconds);
  const insert = db.prepare(`INSERT INTO file_handoffs (id, secret_hash, owner_id, drive_id, device_key, name, mime, size, audience, expires_at, grant_id, drive_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  return db.transaction(() => files.map((f) => {
    const id = nanoid(16), secret = randomBytes(24).toString("base64url");
    insert.run(id, sha256(secret), ownerId, driveId, f.deviceKey, f.name, f.mime, f.size, audience, expires, grantId, f.drivePath ?? null);
    return { id, secret, name: f.name, deviceKey: f.deviceKey, expiresAt: expires.replace(" ", "T") + "Z" };
  }))();
}

/** Bearer of a handoff grant's MCP view (`/mcp/h/<id>`). */
export const GRANT_TOKEN_PREFIX = "aind_hg_";

/**
 * A handoff batch plus its grant: the links (one per file, as before) and one MCP view over
 * exactly these files, so an agent can list and read what it was given — and nothing else.
 */
export function createHandoffGrant(ownerId: string, driveId: string, files: HandoffFile[], audience: string, ttlSeconds: number) {
  const id = nanoid(16), secret = randomBytes(24).toString("base64url"), expires = expiryOf(ttlSeconds);
  return db.transaction(() => {
    db.prepare("INSERT INTO handoff_grants (id, secret_hash, owner_id, audience, expires_at) VALUES (?, ?, ?, ?, ?)").run(id, sha256(secret), ownerId, audience, expires);
    const links = createHandoffs(ownerId, driveId, files, audience, ttlSeconds, id);
    return { grant: { id, token: GRANT_TOKEN_PREFIX + secret, expiresAt: expires.replace(" ", "T") + "Z" }, links };
  })();
}

export interface GrantRow { id: string; owner_id: string; audience: string; expires_at: string; revoked_at: string | null }

/** The grant if `token` opens it and it is still live; otherwise why not. */
export function openGrant(id: string, token: string): { grant: GrantRow } | { error: "not_found" | "revoked" | "expired" } {
  const row = db.prepare("SELECT id, owner_id, audience, expires_at, revoked_at, secret_hash FROM handoff_grants WHERE id = ?").get(id) as (GrantRow & { secret_hash: string }) | undefined;
  if (!row || !token.startsWith(GRANT_TOKEN_PREFIX)) return { error: "not_found" };
  const a = Buffer.from(row.secret_hash, "hex"), b = Buffer.from(sha256(token.slice(GRANT_TOKEN_PREFIX.length)), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { error: "not_found" };
  if (row.revoked_at) return { error: "revoked" };
  if (Date.parse(row.expires_at.replace(" ", "T") + "Z") <= Date.now()) return { error: "expired" };
  const { secret_hash: _, ...grant } = row;
  return { grant };
}

/** The grant's files that are still live — a revoked or expired link drops out of the view too. */
export function grantFiles(grantId: string): HandoffRow[] {
  return db.prepare(`SELECT * FROM file_handoffs WHERE grant_id = ? AND revoked_at IS NULL AND expires_at > datetime('now') ORDER BY name`).all(grantId) as HandoffRow[];
}

/** The link if `secret` opens it and it is still live; otherwise why not. */
export function openHandoff(id: string, secret: string): { row: HandoffRow } | { error: "not_found" | "revoked" | "expired" } {
  const row = db.prepare("SELECT * FROM file_handoffs WHERE id = ?").get(id) as HandoffRow | undefined;
  if (!row) return { error: "not_found" };
  const a = Buffer.from(row.secret_hash, "hex"), b = Buffer.from(sha256(secret || ""), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { error: "not_found" };
  if (row.revoked_at) return { error: "revoked" };
  if (Date.parse(row.expires_at.replace(" ", "T") + "Z") <= Date.now()) return { error: "expired" };
  return { row };
}

export function logFetch(id: string, ip: string | null, userAgent: string | null, status: number) {
  db.prepare("INSERT INTO file_handoff_fetches (handoff_id, ip, user_agent, status) VALUES (?, ?, ?, ?)").run(id, ip, userAgent?.slice(0, 200) ?? null, status);
}

export function listHandoffs(ownerId: string, limit = 100) {
  return db.prepare(`SELECT h.id, h.drive_id, h.name, h.mime, h.size, h.audience, h.created_at, h.expires_at, h.revoked_at,
      (SELECT COUNT(*) FROM file_handoff_fetches f WHERE f.handoff_id = h.id AND f.status < 400) AS fetches,
      (SELECT MAX(at) FROM file_handoff_fetches f WHERE f.handoff_id = h.id AND f.status < 400) AS last_fetch_at
    FROM file_handoffs h WHERE h.owner_id = ? ORDER BY h.created_at DESC LIMIT ?`).all(ownerId, limit);
}

/** Revoke one link (or every live link to an audience); only the owner's. Returns how many. */
export function revokeHandoffs(ownerId: string, which: { id?: string; audience?: string }): number {
  if (which.audience) db.prepare("UPDATE handoff_grants SET revoked_at = datetime('now') WHERE audience = ? AND owner_id = ? AND revoked_at IS NULL").run(which.audience, ownerId);
  if (which.id) return db.prepare("UPDATE file_handoffs SET revoked_at = datetime('now') WHERE id = ? AND owner_id = ? AND revoked_at IS NULL").run(which.id, ownerId).changes;
  if (which.audience) return db.prepare("UPDATE file_handoffs SET revoked_at = datetime('now') WHERE audience = ? AND owner_id = ? AND revoked_at IS NULL").run(which.audience, ownerId).changes;
  return 0;
}

/** One chunk of a handoff's bytes, from wherever the row says they are. */
export async function readHandoffChunk(
  h: HandoffRow, driveSecret: string, offset: number, length: number,
): Promise<{ data: string; eof: boolean; size: number }> {
  if (h.drive_path) {
    const r = await callAgent(h.drive_id, driveSecret, { method: "download-chunk", path: h.drive_path, offset, length }) as { data: string; eof: boolean };
    return { data: r.data, eof: r.eof, size: h.size };
  }
  return await callAgent(h.drive_id, driveSecret, { method: "handoff-read", key: h.device_key, offset, length }) as { data: string; eof: boolean; size: number };
}
