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
