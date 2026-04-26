/**
 * Per-owner cached file + folder counts (across all of the owner's drives).
 *
 * The agent on the user's box owns the actual filesystem; we mirror only
 * the counts here so write/mkdir/delete handlers can enforce the tier
 * caps without an O(N) walk per request.
 *
 *   bumpOwnerUsage(ownerId, { files, folders })  // signed deltas
 *   getOwnerUsage(ownerId)                       // { files, folders }
 *
 * On the very first read for an owner the cache is empty (0/0). The
 * counts only become accurate as the owner writes through aindrive —
 * fine because the limits are *upper* bounds, not exact quotas.
 */

import { db } from "./db.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS storage_usage (
    owner_id TEXT PRIMARY KEY,
    files    INTEGER NOT NULL DEFAULT 0,
    folders  INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  )
`);

const _get = db.prepare("SELECT files, folders FROM storage_usage WHERE owner_id = ?");
const _upsert = db.prepare(`
  INSERT INTO storage_usage (owner_id, files, folders, updated_at)
  VALUES (?, MAX(0, ?), MAX(0, ?), strftime('%s','now') * 1000)
  ON CONFLICT(owner_id) DO UPDATE SET
    files   = MAX(0, files   + excluded.files),
    folders = MAX(0, folders + excluded.folders),
    updated_at = strftime('%s','now') * 1000
`);

export function getOwnerUsage(ownerId) {
  const row = _get.get(ownerId);
  return row ? { files: row.files, folders: row.folders } : { files: 0, folders: 0 };
}

export function bumpOwnerUsage(ownerId, delta = {}) {
  const dFiles = Number.isInteger(delta.files) ? delta.files : 0;
  const dFolders = Number.isInteger(delta.folders) ? delta.folders : 0;
  if (dFiles === 0 && dFolders === 0) return;
  // INSERT path uses the deltas as initial values; clamp to 0 in SQL.
  _upsert.run(ownerId, dFiles, dFolders);
}
