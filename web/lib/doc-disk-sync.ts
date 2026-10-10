// Disk ↔ collaborative-doc reconciliation for the file editors (Monaco on
// Y.Text("content"), TipTap on the "prosemirror" fragment).
//
// Why this exists (incident 2026-10-10, drive -nLGGiI3VXYR): a `git push` into
// a non-bare repo rewrote files on disk; minutes later the web editor wrote the
// PREVIOUS text back. Two defects combined:
//   1. On open, a non-empty CRDT (IndexedDB / Willow store) was treated as
//      authoritative and the disk was never consulted, so a file changed by an
//      external tool while no editor was open came up stale.
//   2. Autosave armed on ANY Y.Doc update, including the IndexedDB restore,
//      the server sync and the reload re-seed — none of them a user edit — so
//      merely opening the file scheduled a write of the stale text.
//
// The rules below make the disk authoritative for external changes and make a
// write require a real local edit:
//   - A doc remembers the hash of the text it last loaded from or wrote to disk
//     (`lastDiskHash`). On open, if the disk hash differs from the one this
//     browser last knew for the path, the disk changed externally → the disk
//     wins (the doc is replaced, generation bumps). Only a doc whose disk is
//     unchanged since we last saw it keeps its (possibly offline-edited) state.
//   - fs-changed → reload: the disk wins unconditionally when its content
//     differs from the doc; a matching hash is our own write echoing back.
//   - A write happens only when `dirty` (a local-origin update since the last
//     load/write) AND the text differs from what is on disk.
// The hash is a fast synchronous 53-bit string hash: this is change detection
// between two texts we hold, not integrity.

export type OpenDecision = "seed-from-disk" | "keep-doc" | "replace-from-disk";

export interface DiskSyncState {
  /** Hash of the text last loaded from or written to disk; null before the first load. */
  lastDiskHash: string | null;
  /** A local (user) edit happened since the last load/write. */
  dirty: boolean;
  /** Bumped every time the doc is replaced from disk; lets UIs/tests observe reloads. */
  generation: number;
}

export function hashText(s: string): string {
  // cyrb53 — public-domain 53-bit hash, good enough to tell two texts apart.
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + "." + s.length.toString(36);
}

export function createDiskSync(lastKnownDiskHash: string | null = null): DiskSyncState {
  return { lastDiskHash: lastKnownDiskHash, dirty: false, generation: 0 };
}

/**
 * Decide what to show when a doc opens. `docEmpty`: the CRDT carries nothing
 * (first open on this browser with no stored state). `docEqualsDisk` is the
 * caller's notion of equality (byte-equal for code; canonical-equal for
 * markdown whose serializer normalizes). `lastKnownDiskHash` is what this
 * browser remembered for the path (persisted across sessions), or null.
 */
export function decideOnOpen(args: {
  docEmpty: boolean;
  docEqualsDisk: boolean;
  diskHash: string;
  lastKnownDiskHash: string | null;
}): OpenDecision {
  if (args.docEmpty) return "seed-from-disk";
  if (args.docEqualsDisk) return "keep-doc";
  // The doc and the disk disagree. If the disk still holds what we last
  // loaded/wrote, the difference is ours (offline or unsaved edits) → keep it.
  // Otherwise something else wrote the file → the disk is authoritative.
  if (args.lastKnownDiskHash !== null && args.lastKnownDiskHash === args.diskHash) return "keep-doc";
  return "replace-from-disk";
}

/** Record that the doc now mirrors `diskText` (after a seed, a reload or a successful write). */
export function markLoaded(state: DiskSyncState, diskText: string, opts: { replaced?: boolean } = {}): DiskSyncState {
  return {
    lastDiskHash: hashText(diskText),
    dirty: false,
    generation: opts.replaced ? state.generation + 1 : state.generation,
  };
}

/** A Y.Doc update arrived; only local-origin updates make the doc dirty. */
export function noteUpdate(state: DiskSyncState, origin: "local" | "remote" | "idb-restore" | "programmatic"): DiskSyncState {
  if (origin !== "local") return state;
  return state.dirty ? state : { ...state, dirty: true };
}

/** fs-changed → reload: should the doc be replaced by `diskText`? */
export function shouldReloadFromDisk(state: DiskSyncState, diskText: string, docEqualsDisk: boolean): boolean {
  if (docEqualsDisk) return false;
  // Our own write echoing back through fs.watch: disk == what we just wrote.
  if (state.lastDiskHash !== null && hashText(diskText) === state.lastDiskHash && !state.dirty) return false;
  return true;
}

/** Autosave / flush: may `text` be written to disk? */
export function shouldWriteBack(state: DiskSyncState, text: string): boolean {
  if (!state.dirty) return false;
  if (state.lastDiskHash !== null && hashText(text) === state.lastDiskHash) return false;
  return true;
}

// ── Per-path memory of the last disk hash this browser saw ───────────────────
// Survives page reloads so the open-time decision can tell "offline edits we
// own" from "someone else changed the file". localStorage may be unavailable
// (private mode, blocked site data) → every read is null and every write a no-op.

const KEY_PREFIX = "aindrive:diskhash:";

export function loadKnownDiskHash(driveId: string, path: string): string | null {
  try { return globalThis.localStorage?.getItem(KEY_PREFIX + driveId + ":" + path) ?? null; } catch { return null; }
}

export function storeKnownDiskHash(driveId: string, path: string, hash: string | null): void {
  try {
    const k = KEY_PREFIX + driveId + ":" + path;
    if (hash === null) globalThis.localStorage?.removeItem(k); else globalThis.localStorage?.setItem(k, hash);
  } catch { /* per-viewer convenience only */ }
}
