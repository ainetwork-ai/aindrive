/**
 * File handoff links — how an owner's device hands ONE picked file to an outside agent (A2A).
 *
 * The device picks the files and registers each under a random `device_key` it keeps locally;
 * this module stores a link per file: `/api/h/<id>?k=<secret>` (id + secret, only the secret's
 * hash kept). A fetch of that URL is checked (secret, expiry, revocation), logged, and served by
 * streaming `handoff-read` RPCs from the device through its carrier drive's socket — nothing is
 * cached on the server, and the device serves only keys it registered (so a link can never reach
 * other files, even in the same folder). Owners list and revoke their links (/api/handoffs).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { nanoid } from "nanoid";
import { db } from "./db";

export const MAX_TTL_SECONDS = 60 * 60;
export const DEFAULT_TTL_SECONDS = 15 * 60;
export const MAX_FILES = 20;

export interface HandoffFile { deviceKey: string; name: string; mime: string; size: number }
export interface HandoffRow {
  id: string; secret_hash: string; owner_id: string; drive_id: string; device_key: string; name: string; mime: string;
  size: number; audience: string; created_at: string; expires_at: string; revoked_at: string | null;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function createHandoffs(ownerId: string, driveId: string, files: HandoffFile[], audience: string, ttlSeconds: number) {
  const ttl = Math.max(30, Math.min(MAX_TTL_SECONDS, Math.floor(ttlSeconds)));
  const expires = new Date(Date.now() + ttl * 1000).toISOString().replace("T", " ").slice(0, 19);
  const insert = db.prepare(`INSERT INTO file_handoffs (id, secret_hash, owner_id, drive_id, device_key, name, mime, size, audience, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  return db.transaction(() => files.map((f) => {
    const id = nanoid(16), secret = randomBytes(24).toString("base64url");
    insert.run(id, sha256(secret), ownerId, driveId, f.deviceKey, f.name, f.mime, f.size, audience, expires);
    return { id, secret, name: f.name, deviceKey: f.deviceKey, expiresAt: expires.replace(" ", "T") + "Z" };
  }))();
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
  if (which.id) return db.prepare("UPDATE file_handoffs SET revoked_at = datetime('now') WHERE id = ? AND owner_id = ? AND revoked_at IS NULL").run(which.id, ownerId).changes;
  if (which.audience) return db.prepare("UPDATE file_handoffs SET revoked_at = datetime('now') WHERE audience = ? AND owner_id = ? AND revoked_at IS NULL").run(which.audience, ownerId).changes;
  return 0;
}
