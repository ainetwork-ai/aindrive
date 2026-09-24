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
 *
 * Deltas are signed: a create adds 1, a delete subtracts 1. The STORED
 * total is clamped at 0, never the delta — deleting a file that predates
 * the counter (created on the agent's disk directly) must not push it
 * negative, but every counted delete has to free its slot. There is no
 * recount from the agent's filesystem on purpose: files a user put in the
 * shared folder outside aindrive were never counted, and a walk would
 * suddenly count them against the cap.
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
// Both branches use the raw delta. `excluded.files` would be the INSERT value,
// already clamped to 0, so adding it turned every delete into +0.
const _upsert = db.prepare(`
  INSERT INTO storage_usage (owner_id, files, folders, updated_at)
  VALUES (@owner, MAX(0, @files), MAX(0, @folders), strftime('%s','now') * 1000)
  ON CONFLICT(owner_id) DO UPDATE SET
    files   = MAX(0, files   + @files),
    folders = MAX(0, folders + @folders),
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
  _upsert.run({ owner: ownerId, files: dFiles, folders: dFolders });
}
