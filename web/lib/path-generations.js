/**
 * Per-path generations (ain-integration plan task 10.2).
 *
 * Phase A file ids are derived from the path (`p1:` + sha256(driveId, path)),
 * so a reference minted for `a/report.md` would silently resolve to a
 * DIFFERENT file someone later creates at the same path. A generation closes
 * that hole without minted ids: a random nonce stored per (drive, path) the
 * first time the path is handed out, and dropped whenever the path is
 * (re)created or removed — so the next file there gets a new nonce.
 *
 *   refs      carry it in `revision` as a `-g<generation>` suffix
 *             (`m<mtimeMs>-s<size>-g<gen>`); fs/list entries carry
 *             `generation` + `revision`.
 *   fs/read   given `generation=` (or a `revision=` with the suffix), answers
 *             410 resource_deleted when the path's current generation differs
 *             or nothing is there. A ref without a generation reads as before.
 *
 * What drops a path's generation (its subtree too):
 *   - web-mediated create/replace-by-rename/remove: fs/write and fs/upload*
 *     when creating, fs/mkdir, fs/rename (both ends), fs/delete, the
 *     write_file / delete_path skills;
 *   - the agent's own `fs-changed` frame when a stat says the path is gone
 *     (a change made on the owner's disk, lib/agents.js recordFsChange);
 *   - a file whose birth time (`birthtimeMs`, when the agent reports one)
 *     differs from the one recorded — a delete + re-create faster than the
 *     watcher can stat.
 *
 * Dropping is unconditional (a DELETE on rows that only exist once the
 * AIN_INTEGRATION_ENABLED flag handed one out); handing out and checking is
 * behind the flag (lib/ain-integration.js).
 *
 * Plain JS (+ .d.ts) so lib/agents.js (raw node) shares this implementation.
 */
import { randomBytes } from "node:crypto";
import { db } from "./db.js";

const newGeneration = () => randomBytes(8).toString("hex");

/** A generation as refs spell it: 6–32 lowercase hex/alnum characters. */
export const GENERATION_RE = /^[0-9a-z]{6,32}$/;

const birthOf = (entry) => {
  const b = entry && typeof entry.birthtimeMs === "number" ? entry.birthtimeMs : null;
  return b !== null && Number.isFinite(b) && b > 0 ? b : null;
};
// Birth times travel as floats through JSON; a sub-millisecond wobble is the same birth.
const sameBirth = (a, b) => Math.abs(a - b) < 1;

/** The stored row for a path, or null. Never creates one. */
export function peekGeneration(driveId, path) {
  const row = db.prepare("SELECT generation, birth_ms FROM path_generations WHERE drive_id = ? AND path = ?").get(driveId, path);
  return row ?? null;
}

/**
 * The path's current generation, handing one out when it has none. `entry`
 * (an agent list/stat entry) lets a changed birth time rotate it: the file
 * there is not the one the old generation named.
 * @param {string} driveId
 * @param {string} path  normalized (lib/path.js normalizePath)
 * @param {{ birthtimeMs?: number } | null} [entry]
 * @returns {string}
 */
export function generationFor(driveId, path, entry) {
  const birth = birthOf(entry);
  const row = peekGeneration(driveId, path);
  if (row) {
    if (birth === null) return row.generation;
    if (row.birth_ms === null || row.birth_ms === undefined) {
      db.prepare("UPDATE path_generations SET birth_ms = ? WHERE drive_id = ? AND path = ?").run(birth, driveId, path);
      return row.generation;
    }
    if (sameBirth(row.birth_ms, birth)) return row.generation;
    const gen = newGeneration();
    db.prepare("UPDATE path_generations SET generation = ?, birth_ms = ?, created_at = datetime('now') WHERE drive_id = ? AND path = ?")
      .run(gen, birth, driveId, path);
    return gen;
  }
  const gen = newGeneration();
  db.prepare("INSERT OR IGNORE INTO path_generations (drive_id, path, generation, birth_ms) VALUES (?, ?, ?, ?)").run(driveId, path, gen, birth);
  // A concurrent insert may have won: the stored value is the answer.
  return peekGeneration(driveId, path)?.generation ?? gen;
}

/**
 * An agent entry was seen for `path` (e.g. by the fs-changed stat): rotate an
 * EXISTING generation if the birth time says the file was re-created. Never
 * hands one out (so this runs with the flag off without creating rows).
 */
export function observeEntry(driveId, path, entry) {
  if (birthOf(entry) === null || !peekGeneration(driveId, path)) return;
  generationFor(driveId, path, entry);
}

/** Drop the generation of `path` and of everything under it ("" = the whole drive). */
export function dropGenerations(driveId, path) {
  if (!path) {
    db.prepare("DELETE FROM path_generations WHERE drive_id = ?").run(driveId);
    return;
  }
  const esc = path.replace(/[\\%_]/g, (c) => "\\" + c);
  db.prepare("DELETE FROM path_generations WHERE drive_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\')").run(driveId, path, `${esc}/%`);
}

/** `revision` carrying a generation: `<rev>-g<gen>`. */
export function revisionWithGeneration(revision, generation) {
  return `${revision}-g${generation}`;
}

/** The generation a ref's `revision` carries, or null (an old ref, or another product's revision). */
export function generationOfRevision(revision) {
  if (typeof revision !== "string") return null;
  const m = /-g([0-9a-z]{6,32})$/.exec(revision);
  return m ? m[1] : null;
}
