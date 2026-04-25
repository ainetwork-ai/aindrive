/**
 * Wire protocol shared between the aindrive web server and the local `aindrive` CLI agent.
 *
 * Every message crossing the bus is server-signed (HMAC-SHA256). The agent verifies
 * the signature before touching the filesystem. The web side verifies the response
 * signature before handing bytes to the UI.
 */

export const PROTOCOL_VERSION = 1;

export type RpcMethod =
  | "list"
  | "stat"
  | "read"
  | "write"
  | "mkdir"
  | "rename"
  | "delete"
  | "upload-chunk"
  | "download-chunk";

export const RPC_METHODS: ReadonlySet<RpcMethod> = new Set([
  "list",
  "stat",
  "read",
  "write",
  "mkdir",
  "rename",
  "delete",
  "upload-chunk",
  "download-chunk",
]);

export type RpcParams =
  | { method: "list"; path: string }
  | { method: "stat"; path: string }
  | { method: "read"; path: string; encoding?: "utf8" | "base64"; maxBytes?: number }
  | { method: "write"; path: string; content: string; encoding?: "utf8" | "base64" }
  | { method: "mkdir"; path: string }
  | { method: "rename"; from: string; to: string }
  | { method: "delete"; path: string }
  | { method: "upload-chunk"; path: string; chunkId: number; total: number; data: string }
  | { method: "download-chunk"; path: string; offset: number; length: number };

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
  | { method: "upload-chunk"; ok: true; receivedBytes: number }
  | { method: "download-chunk"; data: string; eof: boolean };

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

export const REQ_QUEUE = (driveId: string) => `aindrive:drive:${driveId}:req`;
export const RES_QUEUE = (driveId: string, reqId: string) => `aindrive:drive:${driveId}:res:${reqId}`;
export const HEARTBEAT_KEY = (driveId: string) => `aindrive:drive:${driveId}:alive`;

export const LIMITS = {
  maxPathBytes: 4096,
  maxReadBytes: 8 * 1024 * 1024,
  maxUploadChunkBytes: 4 * 1024 * 1024,
  maxInFlightPerDrive: 64,
  rpcTimeoutMs: 25_000,
  heartbeatTtlSec: 30,
} as const;
