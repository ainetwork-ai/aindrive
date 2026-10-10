import { callAgent } from "./rpc";
import { classifyKind } from "./mime";
import type { DriveEntry } from "./protocol";
import { runLanguageFor } from "./git-panel";

/**
 * Running a repo file on ainize (the ▶ Run button of the web git panel).
 *
 * aindrive does not execute code: the run route (app/api/drives/[driveId]/run)
 * gathers the repo's text files through the drive's agent and hands them to
 * ainize's runner, then relays its event stream unchanged.
 *
 * Dependency — ainize `POST ${AINIZE_URL}/api/run` (env AINIZE_URL, default
 * https://ainize.ai; built alongside this feature, so this module codes against
 * the contract and the tests mock it):
 *   request  JSON { language: "python" | "node", entry: "<path in files>",
 *                   files: [{ path, content }], env: { AINIZE_DECIDE_URL }, timeoutMs }
 *   response text/event-stream with events
 *     stdout {text}  stderr {text}  exit {code, durationMs}  error {message}
 *   503 = runner unavailable (not deployed / no capacity): the route relays it
 *   as 503 { error: "runner unavailable" } and the UI shows that state.
 * `AINIZE_DECIDE_URL` lets the program call ainize's decide endpoint without
 * knowing which host runs it.
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

export function runOnAinize(opts: { language: RunLanguage; entry: string; files: RunFile[] }): Promise<Response> {
  const base = ainizeUrl();
  return fetch(`${base}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({
      language: opts.language,
      entry: opts.entry,
      files: opts.files,
      env: { AINIZE_DECIDE_URL: `${base}/api/decide` },
      timeoutMs: RUN_TIMEOUT_MS,
    }),
  });
}
