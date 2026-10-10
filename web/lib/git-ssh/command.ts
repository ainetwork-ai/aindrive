/**
 * The one line a git client sends over SSH, and the repo path inside it.
 *
 *   git clone git@aindrive.ainetwork.ai:comcom/clef-artwork-search
 *     → exec  git-upload-pack 'comcom/clef-artwork-search'
 *   git push  git@aindrive.ainetwork.ai:comcom/clef-artwork-search main
 *     → exec  git-receive-pack 'comcom/clef-artwork-search'
 *
 * Only these two commands exist here (no shell, no sftp, no other git
 * subcommand). The path is either
 *   <org-slug>/<repo-path>     the AIN SSO organization's drive (lib/git-slug.ts), or
 *   d/<driveId>/<repo-path>    an explicit drive id,
 * with an optional leading `/` and trailing `.git`, exactly as the HTTP URLs
 * /<slug>/git/<repo> and /api/drives/<driveId>/git/<repo> spell them.
 * `d` is a reserved top-level name (git-slug.ts RESERVED), so the two forms
 * can never be confused.
 */
export type GitService = "upload-pack" | "receive-pack";

export type GitCommand = { service: GitService; rawPath: string };

export type RepoTarget =
  | { kind: "slug"; slug: string; repo: string }
  | { kind: "drive"; driveId: string; repo: string };

// `git-upload-pack 'path'` (what git sends), also `git upload-pack 'path'` and
// an unquoted path (some clients / tooling). Nothing else: no options.
const CMD_RE = /^\s*git(?:-| )(upload-pack|receive-pack)\s+(?:'([^']+)'|"([^"]+)"|([^\s'"]+))\s*$/;

export function parseGitCommand(command: string): GitCommand | null {
  if (typeof command !== "string" || command.length > 4096) return null;
  const m = CMD_RE.exec(command);
  if (!m) return null;
  const rawPath = m[2] ?? m[3] ?? m[4] ?? "";
  if (!rawPath) return null;
  return { service: m[1] as GitService, rawPath };
}

const SEGMENT_OK = (s: string) => s.length > 0 && s !== "." && s !== ".." && !/[\x00-\x1f\x7f\\]/.test(s);
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export function parseRepoTarget(rawPath: string): RepoTarget | null {
  let p = String(rawPath ?? "").trim();
  if (!p || p.length > 2048 || /[\x00-\x1f\x7f]/.test(p)) return null;
  p = p.replace(/^\/+/, "").replace(/\/+$/, "");
  if (p.endsWith(".git")) p = p.slice(0, -".git".length);
  const segs = p.split("/");
  if (!segs.every(SEGMENT_OK)) return null;
  if (segs[0] === "d") {
    if (segs.length < 3 || !DRIVE_ID_RE.test(segs[1])) return null;
    return { kind: "drive", driveId: segs[1], repo: segs.slice(2).join("/") };
  }
  if (segs.length < 2) return null;
  return { kind: "slug", slug: segs[0], repo: segs.slice(1).join("/") };
}

export const minRoleFor = (svc: GitService): "editor" | "viewer" => (svc === "receive-pack" ? "editor" : "viewer");
