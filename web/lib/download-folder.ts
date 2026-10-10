import { randomUUID } from "node:crypto";
import { db } from "@/lib/db.js";
import { paidAccessDenial } from "@/lib/sale-access.js";
import { isAncestorOrSelf, type NormalizedPath } from "@/lib/path";
import type { Role } from "@/lib/access";
import { AgentError, callAgent } from "@/lib/rpc";
import { agentTempFileStream } from "@/lib/agent-stream";
import { basenameForDownload } from "@/lib/mime";

/**
 * Folder download: the agent zips a folder to a temp file, the web streams it.
 * Shared by the fs/download-folder route's two phases (prepare → JSON with a
 * token; fetch → bytes), see app/api/drives/[driveId]/fs/download-folder/route.ts.
 */

/** Where the agent may write a folder zip (cli/src/rpc.js ZIP_TMP_DIR); one file per job id. */
export const ZIP_TMP_DIR = ".aindrive/uploads/zip";
export const zipTempPath = (job: string) => `${ZIP_TMP_DIR}/${job}.zip`;
export const newZipJob = () => randomUUID();
/** The agent walks and compresses within this; the web waits as long. */
export const ZIP_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Paid descendants of `dir` this caller may NOT read, as paths relative to
 * `dir` — exactly the entries fs/list would show locked or hide anywhere in the
 * subtree (one rule: lib/listing-visibility.ts, readDenial). The folder's own
 * lock is the caller's business (the gate already answered 402); this lists
 * what a readable folder still withholds. editor+ get an empty list.
 */
export function lockedDescendants(driveId: string, dir: NormalizedPath, role: Role, userId: string | null): string[] {
  const rows = db
    .prepare("SELECT path, expires_at FROM shares WHERE drive_id = ? AND price_usdc IS NOT NULL")
    .all(driveId) as { path: string; expires_at: string | null }[];
  const now = new Date();
  const out = new Set<string>();
  for (const r of rows) {
    if (r.expires_at && new Date(r.expires_at) < now) continue;
    // shares.path is written through normalizePath (lib/path.d.ts): the brand holds.
    const sharePath = r.path as NormalizedPath;
    if (sharePath === dir || !isAncestorOrSelf(dir, sharePath)) continue;
    if (!paidAccessDenial(driveId, r.path, role, userId)) continue;
    out.add(dir ? r.path.slice(dir.length + 1) : r.path);
  }
  return [...out].sort();
}

export type ZipJobResult = { job: string; size: number; files: number; bytes: number; skipped: number };

/** Asks the agent to zip `dir` (minus `exclude`) into a fresh temp file. The caller streams or tokenizes the job. */
export async function zipFolderOnAgent(driveId: string, driveSecret: string, dir: string, exclude: string[]): Promise<ZipJobResult> {
  const job = newZipJob();
  const r = await callAgent(driveId, driveSecret,
    { method: "zip-folder", path: dir, out: zipTempPath(job), exclude },
    { timeoutMs: ZIP_TIMEOUT_MS });
  return { job, size: r.size, files: r.files, bytes: r.bytes, skipped: typeof r.skipped === "number" ? r.skipped : exclude.length };
}

/** `<folder>.zip`, or `<drive name>.zip` for the root. */
export function zipFilename(dir: string, driveName: string): string {
  const base = (dir ? basenameForDownload(dir) : driveName).trim() || "folder";
  return `${base}.zip`;
}

export function zipHeaders(filename: string, size: number, extra: { files?: number; skipped?: number } = {}): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/zip",
    // RFC 6266: filename* for non-ASCII names, filename for legacy clients.
    "content-disposition": `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "content-length": String(size),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  };
  if (extra.files !== undefined) h["x-aindrive-files"] = String(extra.files);
  if (extra.skipped !== undefined) h["x-aindrive-skipped"] = String(extra.skipped);
  return h;
}

/** Streams a prepared zip and deletes it afterwards (also on cancel/error). */
export function zipResponse(driveId: string, driveSecret: string, job: string, size: number, headers: Record<string, string>): Response {
  if (size === 0) {
    callAgent(driveId, driveSecret, { method: "delete", path: zipTempPath(job) }).catch(() => {});
    return new Response(null, { status: 200, headers });
  }
  return new Response(agentTempFileStream(driveId, driveSecret, zipTempPath(job), size), { status: 200, headers });
}

/** HTTP status for an agent failure while zipping: a cap → 413, a vanished folder → 404, else the agent's. */
export function zipErrorStatus(e: unknown): number {
  const err = e as AgentError;
  const msg = err?.message ?? "";
  if (/^zip limit:/.test(msg)) return 413;
  if (/not a directory|ENOENT/.test(msg)) return 404;
  return err?.status ?? 500;
}
