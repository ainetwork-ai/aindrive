// One "session" per opened file in an editor component.
//
// Incident 2026-10-10 07:55 (the regression after #215): the Viewer component
// is not keyed by path, so switching from ainize.json to art_search.py reused
// the component, its debounced autosave and its disk-sync state. The cleanup of
// the first file flushed the debounce; the flush ran the LATEST autosave
// closure, whose `entry.path` was already art_search.py while `providerRef`
// still held ainize.json's doc — ainize.json's bytes were written under
// art_search.py. Every mutable thing an open file owns now lives in one
// session object created when the file opens: path, generation, disk-sync
// state. A write names the session that produced its text and is refused when
// that session is no longer the active one. Independently, a write whose
// content is byte-identical to what another path in the same drive recently
// loaded is refused (a doc cannot legitimately equal a different file).

import {
  createDiskSync, hashText, markLoaded, noteUpdate, shouldWriteBack, storeKnownDiskHash, type DiskSyncState,
} from "./doc-disk-sync";

export interface EditorSession {
  readonly driveId: string;
  readonly path: string;
  /** Monotonic per page load; a new number for every open, even of the same path. */
  readonly generation: number;
  sync: DiskSyncState;
}

export type WriteVerdict =
  | { ok: true }
  | { ok: false; reason: "stale-session" | "not-dirty" | "unchanged" | "cross-file"; detail?: string };

let nextGeneration = 1;

/** drive → (path → hash of the text that path last loaded from / wrote to disk). */
const recentLoads = new Map<string, Map<string, string>>();

export function openSession(driveId: string, path: string): EditorSession {
  return { driveId, path, generation: nextGeneration++, sync: createDiskSync() };
}

/** The session's doc now mirrors `text` on disk (seed, reload, or a successful write). */
export function sessionLoaded(s: EditorSession, text: string, opts: { replaced?: boolean } = {}): void {
  s.sync = markLoaded(s.sync, text, opts);
  storeKnownDiskHash(s.driveId, s.path, s.sync.lastDiskHash);
  let perDrive = recentLoads.get(s.driveId);
  if (!perDrive) { perDrive = new Map(); recentLoads.set(s.driveId, perDrive); }
  perDrive.set(s.path, s.sync.lastDiskHash as string);
}

export function sessionUpdate(s: EditorSession, origin: "local" | "remote" | "idb-restore" | "programmatic"): void {
  s.sync = noteUpdate(s.sync, origin);
}

/** Another path in the same drive whose last loaded/written text equals `text`, or null. */
export function crossFileMatch(driveId: string, path: string, text: string): string | null {
  if (text.trim() === "") return null; // empty files legitimately coincide
  const h = hashText(text);
  const perDrive = recentLoads.get(driveId);
  if (!perDrive) return null;
  for (const [p, hash] of perDrive) if (p !== path && hash === h) return p;
  return null;
}

/**
 * May `text`, produced by `s`, be written to `s.path`? `active` is the session
 * the component currently shows (null once it unmounted). `requireDirty`
 * false is for an explicit user save, which may write an unchanged-but-dirty
 * doc the same way; the session and cross-file checks always apply.
 */
export function writeVerdict(s: EditorSession, active: EditorSession | null, text: string, opts: { requireDirty?: boolean } = {}): WriteVerdict {
  if (active !== s) return { ok: false, reason: "stale-session", detail: active ? `${s.path} is not the open file (${active.path})` : `${s.path} is closed` };
  const other = crossFileMatch(s.driveId, s.path, text);
  if (other !== null) return { ok: false, reason: "cross-file", detail: `content equals ${other}` };
  if (opts.requireDirty !== false) {
    if (!s.sync.dirty) return { ok: false, reason: "not-dirty" };
    if (!shouldWriteBack(s.sync, text)) return { ok: false, reason: "unchanged" };
  }
  return { ok: true };
}

/** Test hook: forget what every path loaded. */
export function _resetRecentLoads(): void { recentLoads.clear(); }
