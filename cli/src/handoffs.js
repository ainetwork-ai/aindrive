import { promises as fsp, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Files the owner handed to an outside agent from the Mac app (web/lib/handoff.ts; the phone's
 * copy is mobile/android/.../Handoffs.java): a random key per file → its absolute path, until when.
 * The Mac app writes ~/.aindrive/handoffs.json (0600) when the owner confirms a handoff; any of
 * this Mac's agents can carry the bytes, and `handoff-read` serves ONLY registered, unexpired keys —
 * a handoff link can never reach any other file, not even a neighbour in the same folder.
 */
export const HANDOFFS_FILE = join(homedir(), ".aindrive", "handoffs.json");
const CHUNK = 4 * 1024 * 1024;

export function lookupHandoff(key, file = HANDOFFS_FILE, now = Date.now()) {
  if (typeof key !== "string" || !key || !existsSync(file)) return null;
  let all;
  try { all = JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
  const e = Object.prototype.hasOwnProperty.call(all, key) ? all[key] : null;
  if (!e || typeof e.path !== "string" || !(e.expiresAt > now)) return null;
  return e;
}

/** Bytes [offset, offset+length) of a registered file, with its size. */
export async function readHandoff(key, offset = 0, length = CHUNK, file = HANDOFFS_FILE) {
  const e = lookupHandoff(key, file);
  if (!e) throw new Error("no such handoff (expired or never registered)");
  const fh = await fsp.open(e.path, "r");
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error("file is gone");
    const n = Math.max(0, Math.min(length ?? CHUNK, CHUNK));
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, Math.max(0, offset ?? 0));
    return { data: buf.subarray(0, bytesRead).toString("base64"), eof: (offset ?? 0) + bytesRead >= st.size, size: st.size };
  } finally { await fh.close(); }
}
