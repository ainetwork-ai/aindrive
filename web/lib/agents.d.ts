/**
 * Type shim for the legacy `lib/agents.js` (custom server side).
 * Type definitions for RPC params/results live in `./protocol.ts`
 * (the team's single source of truth) — we re-use them here so any
 * additions there propagate automatically to TS callers of sendRpc.
 */

import type { RpcParams, RpcResult, SendRpcOpts as _SendRpcOpts } from "./protocol";

export type { RpcParams, RpcResult } from "./protocol";

export type SendRpcOpts = { timeoutMs?: number };

export function sendRpc<M extends RpcParams["method"]>(
  driveId: string,
  params: Extract<RpcParams, { method: M }>,
  opts?: SendRpcOpts,
): Promise<Extract<RpcResult, { method: M }>>;

export function isAgentConnected(driveId: string): boolean;
export function listConnectedDrives(): string[];
/** Close the live agent socket for a drive being deleted; false if none was connected. */
/** Closes every device socket of the drive (4410 drive deleted by default; 4401 after a rotation). Returns how many. */
export function disconnectAgent(driveId: string, code?: number, reason?: string): number;
/** An agent's list/stat result with entry names and paths in NFC (the server's path identity). */
export function canonicalAgentResult<R>(result: R): R;
/** HTTP status for an error message the device agent answered with (404 / 400 / 507 / 502). */
export function agentErrorStatus(message: string): number;
/** Ping every interval; terminate a socket whose previous ping got no pong. */
export function startHeartbeat(
  ws: { on(event: "pong", cb: () => void): unknown; ping(): void; terminate(): void; readyState: number; OPEN: number },
  opts?: { intervalMs?: number; onBeat?: () => void; onDead?: () => void },
): ReturnType<typeof setInterval>;
/** Accept a device agent's WebSocket (custom server): auth, registry, heartbeat, frames, change-feed availability. */
export function onAgentConnect(
  ws: { on(event: string, cb: (...args: any[]) => void): unknown; send(data: string): void; close(code?: number, reason?: string): void; ping(): void; terminate(): void; readyState: number; OPEN: number },
  req: { headers: Record<string, string | string[] | undefined> },
  query: { driveId?: string } | undefined,
): Promise<void>;

/** Git over SSH: a live `git <service> <repo>` pipe on the drive's agent (see agents.js openGitExec). */
export type GitExecHandle = {
  execId: string;
  /** Set by the caller: fired when the agent acknowledged stdin bytes (inFlight() dropped). */
  onDrain: (() => void) | null;
  windowBytes: number;
  /** Queue bytes for git's stdin; false when the window is full (pause the source until onDrain). */
  write(buf: Uint8Array): boolean;
  inFlight(): number;
  /** Tell the agent `n` stdout bytes were consumed (it stops at windowBytes unacknowledged). */
  ack(n: number): void;
  end(): void;
  kill(): void;
  readonly finished: boolean;
};
export type GitExecExit = { code: number | null; signal: string | null; error?: string };
export function openGitExec(
  driveId: string,
  target: { repo: string; service: "upload-pack" | "receive-pack"; protocol?: string },
  handlers: { onStdout: (buf: Buffer) => void; onStderr: (buf: Buffer) => void; onExit: (exit: GitExecExit) => void },
): Promise<GitExecHandle>;
