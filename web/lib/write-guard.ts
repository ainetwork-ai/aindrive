/**
 * Guards for writes that name a file by path (plan 12.3: concurrent edits,
 * filename encoding).
 *
 *  - withPathLock: one write per (drive, canonical path) at a time in this
 *    server process. The WS agent registry pins a drive's traffic to one
 *    process (see lib/upload-sessions.ts), so this serializes every
 *    web-mediated write of a path — also on agents that still write in place
 *    (older CLIs, the phone agents), where two overlapping writes used to
 *    interleave into one corrupt file.
 *  - Conditional writes: a writer that read revision R sends it back as
 *    `baseRevision` (or `If-Match`); if the file changed since, the write is
 *    refused with 409 `conflict` and the current revision instead of silently
 *    overwriting the other writer. `none` (or `If-None-Match: *`) = create
 *    only. A revision is the listing's `m<mtimeMs>-s<size>`; a `-g<gen>` suffix
 *    (AIN_INTEGRATION_ENABLED listings) is ignored for the comparison.
 *  - Backslashes: aindrive paths are '/'-separated and the cross-product
 *    contract spells a path with '\' turned into '/', so a name holding '\'
 *    would get the id — and the sourceUrl — of a different path. New names
 *    with '\' are refused; files a device already has keep working in-drive.
 */
export const CREATE_ONLY = "none";

const locks = new Map<string, Promise<unknown>>();

export async function withPathLock<T>(driveId: string, path: string, fn: () => Promise<T>): Promise<T> {
  const key = `${driveId}\0${path.normalize("NFC")}`;
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  const chained = prev.then(() => mine);
  locks.set(key, chained);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}

/** `m<mtimeMs>-s<size>` of an agent stat entry. */
export function baseRevisionOf(e: { mtimeMs?: number | null; size?: number | null }): string {
  return `m${e.mtimeMs ?? 0}-s${e.size ?? 0}`;
}

/** Drops quotes, a weak `W/` prefix and the `-g<gen>` suffix. */
export function canonicalRevision(r: string): string {
  return r.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1").replace(/-g[0-9a-f]+$/i, "");
}

/**
 * The expected revision a request names, or null when it names none.
 * The body field wins over the headers.
 */
export function expectedRevision(body: string | undefined, headers: Headers): string | null {
  if (typeof body === "string" && body.trim()) {
    return body.trim().toLowerCase() === CREATE_ONLY ? CREATE_ONLY : canonicalRevision(body);
  }
  if ((headers.get("if-none-match") ?? "").trim() === "*") return CREATE_ONLY;
  const ifMatch = headers.get("if-match");
  if (ifMatch && ifMatch.trim() && ifMatch.trim() !== "*") return canonicalRevision(ifMatch.split(",")[0]);
  return null;
}

export type Current = { exists: false } | { exists: true; isDir: boolean; revision: string };

/** null = go ahead; otherwise the reason the conditional write must not run. */
export function conflictWith(expected: string | null, current: Current): { currentRevision: string | null } | null {
  if (expected === null) return null;
  if (expected === CREATE_ONLY) return current.exists ? { currentRevision: current.exists && !current.isDir ? current.revision : null } : null;
  if (!current.exists || current.isDir) return { currentRevision: null };
  return canonicalRevision(current.revision) === expected ? null : { currentRevision: current.revision };
}

/** Contract-shaped 409 body (errors.ts shape plus the revision to re-read). */
export function conflictBody(currentRevision: string | null) {
  return {
    error: {
      code: "conflict",
      message: currentRevision
        ? "the file changed since that revision — re-read it and retry"
        : "the file does not match that revision (it is missing, a folder, or already exists)",
      retryable: false,
      currentRevision,
    },
  };
}

/** True when a path names a file or folder with a '\' in it (see header). */
export function hasBackslash(path: string): boolean {
  return path.includes("\\");
}

export const BACKSLASH_ERROR = "file and folder names cannot contain '\\'";
