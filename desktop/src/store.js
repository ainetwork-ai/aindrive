/**
 * The app's own settings: which folders it shares (and which are paused), the
 * server, and whether open-at-login was already set once. The per-folder
 * drive credentials stay where the CLI keeps them (`<folder>/.aindrive/`).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** @typedef {{ folders: { path: string, paused: boolean }[], server?: string, loginItemAsked?: boolean }} Settings */

export function createStore(file) {
  /** @type {Settings} */
  let data = { folders: [] };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (raw && Array.isArray(raw.folders)) data = { ...raw, folders: raw.folders.filter((f) => f && typeof f.path === "string") };
  } catch { /* first launch */ }
  return {
    get: () => data,
    /** @param {(s: Settings) => Settings} fn */
    update(fn) {
      data = fn(data);
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2));
      renameSync(tmp, file);
    },
  };
}
