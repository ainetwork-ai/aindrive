export const PROTOCOL_VERSION = 1;

export type RpcMethod =
  | "list" | "stat" | "read" | "write" | "mkdir" | "rename" | "delete"
  | "upload-chunk" | "download-chunk"
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
  // Git over SSH (lib/git-ssh/*): the same two services as a live bidirectional
  // pipe on the agent WebSocket — git speaks its stateful protocol over SSH, so
  // the stateless one-request/one-result shape above cannot serve it.
  | "git-ssh-exec";

export type RpcParams =
  | { method: "list"; path: string }
  | { method: "stat"; path: string }
  | { method: "read"; path: string; encoding?: "utf8" | "base64"; maxBytes?: number }
  | { method: "write"; path: string; content: string; encoding?: "utf8" | "base64" }
  | { method: "mkdir"; path: string }
  | { method: "rename"; from: string; to: string }
  | { method: "delete"; path: string }
  | { method: "upload-chunk"; path: string; chunkId: number; total: number; data: string }
  | { method: "download-chunk"; path: string; offset: number; length: number }
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
  | { method: "git-commit"; repo: string; message: string; authorName: string; authorEmail: string }
  // Git over SSH: spawn `git <service> <repo>` as a live pipe identified by `execId`
  // (cli/src/git-exec.js). The answer means "running, stdin open"; the bytes then
  // travel as GitStreamFrame frames on the same socket, never as RPC payloads.
  // `protocol` is the client's GIT_PROTOCOL (e.g. "version=2"), passed to git's environment.
  | { method: "git-ssh-exec"; repo: string; service: "upload-pack" | "receive-pack"; execId: string; protocol?: string };

/** One commit as the agent's `git log` reports it (`date` is ISO 8601, author date). */
export type GitCommit = { sha: string; subject: string; author: string; date: string };

/** What a drive folder that is a git repo shows in the web git panel. */
export type GitMeta =
  | { method: "git-meta"; exists: false }
  | { method: "git-meta"; exists: true; branch: string; head: GitCommit | null; dirty: number; commits: GitCommit[] };

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
  | { method: "yjs-write"; ok: true; bytes: number }
  | { method: "yjs-read"; data: string; bytes: number }
  | { method: "agent-ask"; answer: string; sources: AskSource[]; action?: Record<string, unknown> }
  | { method: "handoff-read"; data: string; eof: boolean; size: number }
  | { method: "thumbnail"; data: string; mime: string }
  | { method: "git-advertise"; exists: boolean; data: string }
  | { method: "git-init"; ok: true }
  | { method: "git-service"; ok: true; size: number }
  | GitMeta
  | { method: "git-commit"; sha: string }
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
