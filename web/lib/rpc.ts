import { sendRpc, isAgentConnected } from "./agents.js";
import type { RpcParams, RpcResult } from "./protocol";

export class AgentError extends Error {
  status: number;
  constructor(msg: string, status = 502) { super(msg); this.status = status; }
}

export function isOnline(driveId: string): boolean {
  return isAgentConnected(driveId);
}

export async function callAgent<M extends RpcParams["method"]>(
  driveId: string,
  _driveSecret: string,
  params: Extract<RpcParams, { method: M }>,
  opts: { timeoutMs?: number } = {}
): Promise<Extract<RpcResult, { method: M }>> {
  try {
    const result = await sendRpc(driveId, params, opts);
    return result as Extract<RpcResult, { method: M }>;
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    throw new AgentError((e as Error).message || "agent error", status);
  }
}
