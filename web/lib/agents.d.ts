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
export function disconnectAgent(driveId: string): boolean;
/** An agent's list/stat result with entry names and paths in NFC (the server's path identity). */
export function canonicalAgentResult<R>(result: R): R;
/** Ping every interval; terminate a socket whose previous ping got no pong. */
export function startHeartbeat(
  ws: { on(event: "pong", cb: () => void): unknown; ping(): void; terminate(): void; readyState: number; OPEN: number },
  opts?: { intervalMs?: number; onBeat?: () => void; onDead?: () => void },
): ReturnType<typeof setInterval>;
export function recordAgentHello(driveId: string, msg: unknown): void;
export function forgetAgentCapabilities(driveId: string): void;
export function agentMaterializes(driveId: string): boolean;
