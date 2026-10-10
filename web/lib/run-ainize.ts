import { callAgent } from "./rpc";
import { classifyKind } from "./mime";
import type { DriveEntry } from "./protocol";
import { runLanguageFor } from "./git-panel";
import { pusherOf } from "./git-project-hooks";
import { serviceToken } from "./sso/service-token";
import { log } from "./logger.js";

/**
 * Running a repo file on ainize (the ▶ Run button of the web git panel).
 *
 * aindrive does not execute code: the run route (app/api/drives/[driveId]/run)
 * gathers the repo's text files through the drive's agent and hands them to
 * ainize's runner, then relays its event stream unchanged.
 *
 * Dependency — ainize `POST ${AINIZE_URL}/api/run` (env AINIZE_URL, default
 * https://ainize.ai; ainize-node deploy/run-runtime/README.md):
 *   request  JSON { language: "python" | "node", entry: "<path in files>",
 *                   files: [{ path, content }], env: { ...inputs }, timeoutMs }
 *   response text/event-stream with events
 *     stdout {text}  stderr {text}  exit {code, durationMs}  error {message}
 *   503 = runner unavailable (not deployed / no capacity): the route relays it
 *   as 503 { error: "runner unavailable" } and the UI shows that state.
 *
 * WHO the run is for: the person who pressed ▶. They are signed in here through
 * AIN SSO, and the same account signs in to ainize, so ainize must hand their
 * script THEIR ainize API key — not an anonymous grant, and not ours. aindrive
 * proves itself with its machine token (`Authorization: Bearer <client_credentials
 * at+jwt>` for the ainize origin, lib/sso/service-token.ts; ainize trusts the
 * token's `sub` through its AIN_SSO_SERVICE_APPS) and names the person in
 * `X-AIN-Actor: <their SSO subject>`. ainize resolves the subject to the account
 * it knows from sign-in, issues that account's `aindrive run` key once, and the
 * sandbox gets it as `AINIZE_API_KEY` beside `AINIZE_URL` — so a script is just
 * `ainize.connect(os.environ["AINIZE_URL"], api_key=os.environ["AINIZE_API_KEY"])`
 * with nothing secret in the repo, and its decisions are billed to the person.
 * A person without an SSO identity here, or an aindrive without app credentials,
 * runs anonymously: ainize sets no key and the script says so. Nothing here
 * references ainize's free `/api/decide`.
 */
export const DEFAULT_AINIZE_URL = "https://ainize.ai";
export function ainizeUrl(): string {
  return (process.env.AINIZE_URL?.trim() || DEFAULT_AINIZE_URL).replace(/\/$/, "");
}

export const RUN_MAX_FILES = 32;
export const RUN_MAX_BYTES = 2 * 1024 * 1024;
export const RUN_TIMEOUT_MS = 120_000;
/** Dependency / cache directories never worth shipping to the runner. */
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache", "dist", "build"]);

// Source files the mime table does not know as text (`.py` has no mime type;
// `.ts` is "video/mp2t"), plus the extensionless files a repo usually carries.
const SOURCE_EXTS = new Set(["py", "pyi", "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "toml", "yaml", "yml", "ini", "cfg", "txt", "md", "csv", "env", "sh", "sql", "html", "css"]);
const SOURCE_NAMES = new Set(["makefile", "dockerfile", "procfile", ".gitignore", ".env", ".python-version", "requirements.txt", "pyproject.toml", "package.json"]);
export function isRunText(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (SOURCE_NAMES.has(name)) return true;
  const ext = name.match(/\.([a-z0-9]+)$/)?.[1];
  if (ext && SOURCE_EXTS.has(ext)) return true;
  return classifyKind(path).kind === "text";
}

export type RunFile = { path: string; content: string };
export type RunLanguage = "python" | "node";

export const languageFor = runLanguageFor;

/**
 * The repo's text files, paths relative to `repo`, breadth-first through the
 * agent (`list` + `read`), capped at RUN_MAX_FILES / RUN_MAX_BYTES. Binary
 * files (by extension, isRunText) are skipped — a program that needs its data as bytes
 * is out of scope for this runner.
 */
export async function collectRepoFiles(driveId: string, driveSecret: string, repo: string): Promise<RunFile[]> {
  const files: RunFile[] = [];
  let bytes = 0;
  const queue: string[] = [repo];
  const prefix = repo === "" ? "" : repo + "/";
  while (queue.length && files.length < RUN_MAX_FILES) {
    const dir = queue.shift()!;
    const { entries } = await callAgent(driveId, driveSecret, { method: "list", path: dir }) as { entries: DriveEntry[] };
    for (const e of entries) {
      if (files.length >= RUN_MAX_FILES) break;
      if (e.isDir) { if (!SKIP_DIRS.has(e.name)) queue.push(e.path); continue; }
      if (!isRunText(e.path)) continue;
      if (bytes + e.size > RUN_MAX_BYTES) continue;
      const r = await callAgent(driveId, driveSecret, { method: "read", path: e.path, encoding: "utf8" });
      if (typeof r.content !== "string") continue;
      bytes += Buffer.byteLength(r.content, "utf8");
      files.push({ path: e.path.startsWith(prefix) ? e.path.slice(prefix.length) : e.path, content: r.content });
    }
  }
  return files;
}

/** Who a run is for, as ainize is told: aindrive's machine token for the ainize origin, and the person's SSO subject. */
export type RunActor = { token: string; subject: string };

/**
 * The actor for a run pressed by `userId`: their most recently linked AIN SSO
 * subject plus a machine token for ainize. Null — an anonymous run — when the
 * person has no SSO identity here or aindrive has no app credentials; a token
 * endpoint that refuses or cannot be reached is logged and also falls back,
 * so a sign-in problem at AIN SSO degrades the run (no key) rather than
 * blocking the button.
 */
export async function runActorFor(userId: string | null): Promise<RunActor | null> {
  const subject = pusherOf(userId).subject;
  if (!subject) return null;
  try {
    const token = await serviceToken(ainizeUrl());
    return token ? { token, subject } : null;
  } catch (e) {
    log.warn({ ns: "aindrive.run", userId, err: (e as Error).message }, "no machine token for ainize; running anonymously");
    return null;
  }
}

export function runOnAinize(opts: { language: RunLanguage; entry: string; files: RunFile[]; env?: Record<string, string>; actor?: RunActor | null; signal?: AbortSignal }): Promise<Response> {
  const base = ainizeUrl();
  return fetch(`${base}/api/run`, {
    method: "POST", signal: opts.signal,
    headers: {
      "content-type": "application/json", accept: "text/event-stream",
      ...(opts.actor ? { authorization: `Bearer ${opts.actor.token}`, "x-ain-actor": opts.actor.subject } : {}),
    },
    body: JSON.stringify({
      language: opts.language,
      entry: opts.entry,
      files: opts.files,
      // The person's answers to the manifest's inputs (lib/run-inputs.ts); AINIZE_URL / AINIZE_API_KEY are the sandbox's to set.
      env: { ...(opts.env ?? {}) },
      timeoutMs: RUN_TIMEOUT_MS,
    }),
  });
}

/** Run an immutable repository version on the bound project, with the same actor and SSE contract. */
export function runProjectOnAinize(opts: { projectId: string; target: 'head' | 'commit' | 'deployed'; sha?: string; entry: string; env?: Record<string, string>; actor: RunActor; signal?: AbortSignal }): Promise<Response> {
  return fetch(`${ainizeUrl()}/api/projects/${encodeURIComponent(opts.projectId)}/run`, {
    method: "POST", signal: opts.signal,
    headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${opts.actor.token}`, "x-ain-actor": opts.actor.subject },
    body: JSON.stringify({ target: opts.target, ...(opts.sha ? { sha: opts.sha } : {}), entry: opts.entry, env: opts.env ?? {} }),
  });
}

/** Read the manifest and exact commit using the viewer's identity, never the webhook secret. */
export function projectSourceOnAinize(opts: { projectId: string; target: 'head' | 'commit' | 'deployed'; sha?: string; actor: RunActor; signal?: AbortSignal }): Promise<Response> {
  const query = new URLSearchParams({ target: opts.target, ...(opts.sha ? { sha: opts.sha } : {}) });
  return fetch(`${ainizeUrl()}/api/projects/${encodeURIComponent(opts.projectId)}/source?${query}`, {
    signal: opts.signal, cache: 'no-store',
    headers: { accept: 'application/json', authorization: `Bearer ${opts.actor.token}`, 'x-ain-actor': opts.actor.subject },
  });
}
