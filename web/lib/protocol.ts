export const PROTOCOL_VERSION = 1;

export type RpcMethod =
  | "list" | "stat" | "read" | "write" | "mkdir" | "rename" | "delete"
  | "upload-chunk" | "download-chunk"
  // Folder download (fs/download-folder): the agent zips a folder to a temp file under
  // .aindrive/uploads/zip/ that the web drains with download-chunk and then deletes.
  | "zip-folder"
  | "yjs-write" | "yjs-read"
  | "agent-ask"
  // Device-only (mobile/): bytes of one file the owner registered for a handoff link (lib/handoff.ts).
  | "handoff-read"
  | "thumbnail"
  // Git smart-HTTP (clone/push): the agent runs real git on a repo in the drive FS
  // (non-bare with receive.denyCurrentBranch=updateInstead since git-init went
  // non-bare, so pushed files show up in the drive; legacy bare repos still serve).
  | "git-advertise" | "git-init" | "git-service"
  // Git panel (components/git-panel.tsx): repo summary, and commit-all as the signed-in user.
  | "git-meta" | "git-commit"
  // GitHub-like repo pages (lib/git-urls.ts, app/d/by-slug): read-only views of any ref —
  // branches, one folder of a tree, one file, the log, one commit with its diff.
  | "git-refs" | "git-ls-tree" | "git-show" | "git-log" | "git-commit-detail"
  // Source control on the working copy (components/git-panel.tsx, lib/git-paths.ts for the layout):
  // changes, stage/unstage, discard, push into the bare remote, fast-forward pull from it.
  | "git-status" | "git-stage" | "git-discard" | "git-push" | "git-pull"
  // Git over SSH (lib/git-ssh/*): the same two services as a live bidirectional
  // pipe on the agent WebSocket — git speaks its stateful protocol over SSH, so
  // the stateless one-request/one-result shape above cannot serve it.
  | "git-ssh-exec";

export type RpcParams =
  | { method: "list"; path: string }
  | { method: "stat"; path: string }
  | { method: "read"; path: string; encoding?: "utf8" | "base64"; maxBytes?: number }
  | { method: "write"; path: string; content: string; encoding?: "utf8" | "base64"; source?: string }
  | { method: "mkdir"; path: string }
  | { method: "rename"; from: string; to: string }
  | { method: "delete"; path: string }
  | { method: "upload-chunk"; path: string; chunkId: number; total: number; data: string }
  | { method: "download-chunk"; path: string; offset: number; length: number }
  // `exclude`: '/'-paths relative to `path` the caller may not read (paid locks) — left out, counted in `skipped`.
  | { method: "zip-folder"; path: string; out: string; exclude?: string[] }
  | { method: "yjs-write"; docId: string; data: string }
  | { method: "yjs-read"; docId: string }
  | { method: "agent-ask"; agentId: string; query: string }
  | { method: "handoff-read"; key: string; offset: number; length: number }
  | { method: "thumbnail"; path: string; px?: number }
  // Git smart-HTTP. `service` is "upload-pack" (clone/fetch) or "receive-pack" (push).
  // `repo` is a drive-relative path to a repo (bare or non-bare); in/out are drive-relative temp
  // files under .aindrive/uploads/git/ (an allowed system dir) that web fills via
  // upload-chunk and drains via download-chunk, so large packs never cross as one JSON.
  | { method: "git-advertise"; repo: string; service: "upload-pack" | "receive-pack" }
  | { method: "git-init"; repo: string }
  | { method: "git-service"; repo: string; service: "upload-pack" | "receive-pack"; in: string; out: string }
  | { method: "git-meta"; repo: string }
  // `all` (default true): `git add -A` first; false commits only what is staged.
  | { method: "git-commit"; repo: string; message: string; authorName: string; authorEmail: string; all?: boolean }
  | { method: "git-status"; repo: string }
  | { method: "git-stage"; repo: string; paths: string[]; unstage?: boolean }
  | { method: "git-discard"; repo: string; paths: string[] }
  | { method: "git-push"; repo: string }
  | { method: "git-pull"; repo: string }
  // Repo pages. `ref` is a branch, tag or sha (never an option or a revision expression — the agent
  // refuses those); `path` is repo-relative as git spells it ("" = root). All read the object store.
  | { method: "git-refs"; repo: string }
  | { method: "git-ls-tree"; repo: string; ref: string; path: string }
  | { method: "git-show"; repo: string; ref: string; path: string; maxBytes?: number }
  | { method: "git-log"; repo: string; ref: string; path?: string; n?: number }
  | { method: "git-commit-detail"; repo: string; sha: string }
  // Git over SSH: spawn `git <service> <repo>` as a live pipe identified by `execId`
  // (cli/src/git-exec.js). The answer means "running, stdin open"; the bytes then
  // travel as GitStreamFrame frames on the same socket, never as RPC payloads.
  // `protocol` is the client's GIT_PROTOCOL (e.g. "version=2"), passed to git's environment.
  | { method: "git-ssh-exec"; repo: string; service: "upload-pack" | "receive-pack"; execId: string; protocol?: string };

/** One commit as the agent's `git log` reports it (`date` is ISO 8601, author date). */
export type GitCommit = { sha: string; subject: string; author: string; date: string };

/**
 * What a drive folder that is a git repo shows in the web git panel. `layout`:
 * "working-copy" (origin = the bare sibling, lib/git-paths.ts), "legacy" (a
 * non-bare repo with no bare sibling — read, but nothing to push to), "bare".
 * `ahead`/`behind` are vs origin/<branch> (0 without a remote).
 */
export type GitLayout = "working-copy" | "legacy" | "bare";
export type GitMeta =
  | { method: "git-meta"; exists: false }
  | { method: "git-meta"; exists: true; branch: string; head: GitCommit | null; dirty: number; commits: GitCommit[]; layout: GitLayout; ahead: number; behind: number };
/** One changed path as VS Code shows it: M modified, A added, D deleted, R renamed, U untracked, C conflict. */
export type GitChange = { path: string; status: string };
export type GitStatus = {
  method: "git-status"; branch: string; staged: GitChange[]; unstaged: GitChange[]; untracked: GitChange[];
  ahead: number; behind: number; hasRemote: boolean;
};

/** `git log` with parents, author email and body (repo pages' commit list / detail). */
export type GitCommitFull = GitCommit & { parents: string[]; authorEmail: string; body: string };
/** One row of `git ls-tree -l` at a ref; `lastCommit` is omitted for very large folders. */
export type GitTreeEntry = { name: string; type: "blob" | "tree" | "commit"; mode: string; size: number; lastCommit?: GitCommit | null };
export type GitRefs =
  | { method: "git-refs"; exists: false }
  | { method: "git-refs"; exists: true; head: string; headSha: string | null; branches: { name: string; sha: string }[] };
export type GitCommitDetail = GitCommitFull & {
  method: "git-commit-detail";
  files: { path: string; additions: number | null; deletions: number | null }[];
  /** `git show --patch`, UTF-8, cut at 512 KiB (`truncated`) */
  patch: string;
  truncated: boolean;
};

export type AskSource = {
  path: string;
  snippet: string;
  lineStart?: number;
  lineEnd?: number;
};

export type DriveEntry = {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
  /** Creation time where the agent's filesystem records one (cli ≥ this change; 0/absent = unknown). */
  birthtimeMs?: number;
  ext: string;
  mime: string;
  // Per-path generation (plan task 10.2), set by fs/list with AIN_INTEGRATION_ENABLED:
  // `revision` = `m<mtimeMs>-s<size>-g<generation>`; fs/read?generation= refuses a stale one.
  generation?: string;
  revision?: string;
  // Paid carve-out (R-VIS-PAID-001): set by the fs/list route when the viewer
  // can't yet read this priced child. The agent never sends these — they are
  // server-annotated per requester. UI shows 🔒 + price + ticker.
  locked?: boolean;
  price?: number;
  currency?: string | null;
  shareId?: string;
  listed?: boolean;
};

export type RpcResult =
  | { method: "list"; entries: DriveEntry[] }
  | { method: "stat"; entry: DriveEntry | null }
  | { method: "read"; content: string; encoding: "utf8" | "base64"; truncated?: boolean }
  | { method: "write"; ok: true; bytes: number }
  | { method: "mkdir"; ok: true }
  | { method: "rename"; ok: true }
  | { method: "delete"; ok: true }
  | { method: "upload-chunk"; ok: true; receivedBytes: number }
  | { method: "download-chunk"; data: string; eof: boolean; mtimeMs?: number; size?: number }
  /** `size`: bytes of the zip; `files`/`bytes`: what went in; `skipped`: excluded entries. */
  | { method: "zip-folder"; ok: true; size: number; files: number; bytes: number; skipped: number }
  | { method: "yjs-write"; ok: true; bytes: number }
  | { method: "yjs-read"; data: string; bytes: number }
  | { method: "agent-ask"; answer: string; sources: AskSource[]; action?: Record<string, unknown> }
  | { method: "handoff-read"; data: string; eof: boolean; size: number }
  | { method: "thumbnail"; data: string; mime: string }
  | { method: "git-advertise"; exists: boolean; data: string }
  | { method: "git-init"; ok: true; bare: string; workingCopy: string }
  | { method: "git-service"; ok: true; size: number; workingCopy?: { updated: boolean; reason?: string; branch?: string } }
  | GitMeta
  | { method: "git-commit"; sha: string }
  | GitRefs
  | { method: "git-ls-tree"; sha: string; entries: GitTreeEntry[] }
  | { method: "git-show"; sha: string; size: number; content: string; truncated: boolean }
  | { method: "git-log"; sha: string; commits: GitCommitFull[] }
  | GitCommitDetail
  | GitStatus
  | { method: "git-stage"; ok: true }
  | { method: "git-discard"; ok: true; tracked: number; untracked: number }
  | { method: "git-push"; ok: true; ref: string; before: string; after: string }
  | { method: "git-pull"; ok: true; sha: string }
  | { method: "git-ssh-exec"; ok: true; pid?: number };

/**
 * Git over SSH stream frames, sharing the agent WebSocket with request/response
 * (lib/agents.js openGitExec ↔ cli/src/git-exec.js). Every frame is HMAC-signed
 * with the drive secret over all fields but `type` (lib/sig.js), like a request
 * or response. `data` is base64. Flow control is a byte window per direction:
 * the receiver acks consumed bytes (`ack`) and the sender stops at
 * GIT_SSH_WINDOW_BYTES unacknowledged.
 */
export type GitStdinFrame = {
  type: "git-stdin"; v: typeof PROTOCOL_VERSION; driveId: string; execId: string; seq: number;
  data?: string; eof?: true; kill?: true; ack?: number; sig: string;
};
export type GitStreamFrame =
  | { type: "git-stdout"; execId: string; seq: number; data: string; sig: string }
  | { type: "git-stderr"; execId: string; data: string; sig: string }
  | { type: "git-stdin-ack"; execId: string; ack: number; sig: string }
  | { type: "git-exit"; execId: string; code: number | null; signal: string | null; error?: string; sig: string };
export const GIT_SSH_WINDOW_BYTES = 4 * 1024 * 1024;
export const GIT_SSH_CHUNK_BYTES = 256 * 1024;

export type RpcRequest = {
  v: typeof PROTOCOL_VERSION;
  reqId: string;
  driveId: string;
  issuedAt: number;
  params: RpcParams;
  sig: string;
};

export type RpcResponse =
  | { v: typeof PROTOCOL_VERSION; reqId: string; ok: true; result: RpcResult; sig: string }
  | { v: typeof PROTOCOL_VERSION; reqId: string; ok: false; error: string; sig: string };
