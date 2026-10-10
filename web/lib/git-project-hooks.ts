import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { db } from "./db";
import { env } from "./env";
import { log } from "./logger.js";
import { ainizeUrl } from "./run-ainize";

/**
 * ainize Projects bound to a repo folder (ainize-node docs/PROJECTS.md).
 *
 * A project on ainize binds to one aindrive repo URL + branch; on every push
 * aindrive must POST the project's hook with the updated ref, signed with the
 * project's `webhookSecret` (returned ONCE at project creation, never readable
 * again). So the browser's "Connect to ainize" flow posts `{repo, projectId,
 * webhookSecret}` back to `POST /api/drives/:id/git-connect` (editor), which
 * stores it here per (driveId, repo) — the secret sealed with AES-256-GCM
 * under the session secret, like agent-wallets.ts. After a successful
 * `git-receive-pack` lib/git-http.ts calls `fireProjectHook` for each updated
 * ref: fire-and-forget, 5 s timeout, failures logged, never blocking the push.
 *
 *   POST ${AINIZE_URL}/api/projects/<id>/hook
 *   X-Ainize-Signature: sha256=<hex HMAC-SHA256(raw body, webhookSecret)>
 *   { ref, before, after, pusher: { subject, email } }
 */

function key(): Buffer {
  const secret = env.sessionSecret;
  if (!secret) throw new Error("AINDRIVE_SESSION_SECRET is required to store a project hook secret");
  return createHash("sha256").update(`git-project-hook:${secret}`).digest();
}
function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}
function open(sealed: string): string | null {
  try {
    const [iv, tag, body] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
    const d = createDecipheriv("aes-256-gcm", key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString("utf8");
  } catch { return null; }
}

export type ProjectHook = { projectId: string; secret: string };

/** Bind (or rebind) a repo folder to an ainize project. */
export function storeProjectHook(driveId: string, repo: string, projectId: string, webhookSecret: string, createdBy: string | null): void {
  db.prepare(
    `INSERT INTO git_project_hooks (drive_id, repo, project_id, secret_enc, created_by, created_at) VALUES (?,?,?,?,?,?)
     ON CONFLICT(drive_id, repo) DO UPDATE SET project_id = excluded.project_id, secret_enc = excluded.secret_enc,
       created_by = excluded.created_by, created_at = excluded.created_at`,
  ).run(driveId, repo, projectId, seal(webhookSecret), createdBy, Date.now());
}

export function projectHookFor(driveId: string, repo: string): ProjectHook | null {
  const row = db.prepare("SELECT project_id, secret_enc FROM git_project_hooks WHERE drive_id = ? AND repo = ?").get(driveId, repo) as
    { project_id: string; secret_enc: string } | undefined;
  if (!row) return null;
  const secret = open(row.secret_enc);
  return secret === null ? null : { projectId: row.project_id, secret };
}

/** The project id bound to a repo, without the secret (for the UI / tests). */
export function projectIdFor(driveId: string, repo: string): string | null {
  const row = db.prepare("SELECT project_id FROM git_project_hooks WHERE drive_id = ? AND repo = ?").get(driveId, repo) as { project_id: string } | undefined;
  return row?.project_id ?? null;
}

export function removeProjectHook(driveId: string, repo: string): void {
  db.prepare("DELETE FROM git_project_hooks WHERE drive_id = ? AND repo = ?").run(driveId, repo);
}

export type RefUpdate = { ref: string; before: string; after: string };

/**
 * The ref updates at the head of a `git receive-pack --stateless-rpc` request:
 * pkt-lines `<old-sha> <new-sha> <ref>[\0caps]\n` up to the flush `0000`, then
 * the pack. Only the first bytes are needed, so the caller hands in the first
 * upload chunk. Malformed input → [] (no hook fires; the push itself is git's).
 */
export function parseReceivePackRefs(head: Buffer): RefUpdate[] {
  const out: RefUpdate[] = [];
  let off = 0;
  while (off + 4 <= head.length) {
    const len = parseInt(head.subarray(off, off + 4).toString("latin1"), 16);
    if (!Number.isFinite(len)) break;
    if (len === 0) break; // flush: the pack follows
    if (len < 4 || off + len > head.length) break;
    let line = head.subarray(off + 4, off + len).toString("utf8");
    off += len;
    const nul = line.indexOf("\0");
    if (nul >= 0) line = line.slice(0, nul);
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)/.exec(line.trim());
    if (m) out.push({ before: m[1], after: m[2], ref: m[3] });
  }
  return out;
}

export function signHookBody(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

export type Pusher = { subject: string | null; email: string | null };

/** The pusher as the hook names them: AIN SSO subject (when linked) + account email. */
export function pusherOf(userId: string | null): Pusher {
  if (!userId) return { subject: null, email: null };
  const u = db.prepare("SELECT email FROM users WHERE id = ?").get(userId) as { email: string } | undefined;
  const ident = db.prepare("SELECT subject FROM sso_identities WHERE user_id = ? ORDER BY linked_at DESC LIMIT 1").get(userId) as { subject: string } | undefined;
  return { subject: ident?.subject ?? null, email: u?.email ?? null };
}

export const HOOK_TIMEOUT_MS = 5_000;

/**
 * POST one ref update to the bound project's hook. Resolves to the HTTP status
 * (0 = not sent / network error); never throws. Callers do not await it on the
 * push path — the push's result is git's, the deployment is ainize's.
 */
export async function fireProjectHook(hook: ProjectHook, update: RefUpdate, pusher: Pusher, fetchImpl: typeof fetch = fetch): Promise<number> {
  const body = JSON.stringify({ ref: update.ref, before: update.before, after: update.after, pusher });
  const url = `${ainizeUrl()}/api/projects/${encodeURIComponent(hook.projectId)}/hook`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HOOK_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Ainize-Signature": signHookBody(body, hook.secret) },
      body, signal: ctrl.signal,
    });
    if (!res.ok) log.warn({ projectId: hook.projectId, ref: update.ref, status: res.status }, "ainize project hook refused");
    return res.status;
  } catch (e) {
    log.warn({ projectId: hook.projectId, ref: update.ref, err: (e as Error).message }, "ainize project hook failed");
    return 0;
  } finally { clearTimeout(timer); }
}

/** After a successful push: fire the hook for every updated ref of a bound repo (fire-and-forget). */
export function notifyProjectOfPush(driveId: string, repo: string, head: Buffer, userId: string | null, fetchImpl: typeof fetch = fetch): Promise<number[]> {
  let hook: ProjectHook | null = null;
  try { hook = projectHookFor(driveId, repo); } catch { hook = null; }
  if (!hook) return Promise.resolve([]);
  const updates = parseReceivePackRefs(head);
  if (updates.length === 0) return Promise.resolve([]);
  const pusher = pusherOf(userId);
  return Promise.all(updates.map((u) => fireProjectHook(hook!, u, pusher, fetchImpl)));
}
