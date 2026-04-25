/**
 * Type shim for the legacy `lib/agents.js` (custom server side).
 * Mirrors db.d.ts pattern.
 */

export type RpcParams =
  | { method: "list"; path: string }
  | { method: "stat"; path: string }
  | { method: "read"; path: string; encoding?: "utf8" | "base64"; maxBytes?: number }
  | { method: "write"; path: string; content: string; encoding?: "utf8" | "base64" }
  | { method: "mkdir"; path: string }
  | { method: "rename"; from: string; to: string }
  | { method: "delete"; path: string }
  | { method: "yjs-write"; docId: string; data: string }
  | { method: "yjs-read"; docId: string };

export type DriveEntry = {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
  ext: string;
  mime: string;
};

export type RpcResult =
  | { method: "list"; entries: DriveEntry[] }
  | { method: "stat"; entry: DriveEntry | null }
  | { method: "read"; content: string; encoding: "utf8" | "base64"; truncated?: boolean }
  | { method: "write"; ok: true; bytes: number }
  | { method: "mkdir"; ok: true }
  | { method: "rename"; ok: true }
  | { method: "delete"; ok: true }
  | { method: "yjs-write"; ok: true; bytes: number }
  | { method: "yjs-read"; data: string; bytes: number };

export type SendRpcOpts = { timeoutMs?: number };

export function sendRpc<T extends RpcParams>(
  driveId: string,
  params: T,
  opts?: SendRpcOpts,
): Promise<Extract<RpcResult, { method: T["method"] }>>;

export function isAgentConnected(driveId: string): boolean;
export function listConnectedDrives(): string[];
