export const PROTOCOL_VERSION = 1;

export type RpcMethod =
  | "list" | "stat" | "read" | "write" | "mkdir" | "rename" | "delete"
  | "upload-chunk" | "download-chunk"
  | "yjs-write" | "yjs-read"
  | "agent-ask";

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
  | { method: "agent-ask"; agentId: string; query: string };

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
  | { method: "download-chunk"; data: string; eof: boolean }
  | { method: "yjs-write"; ok: true; bytes: number }
  | { method: "yjs-read"; data: string; bytes: number }
  | { method: "agent-ask"; answer: string; sources: AskSource[] };

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
