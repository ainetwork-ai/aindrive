// Byte-range streaming FROM the agent: wraps sequential download-chunk RPCs
// (STREAM_CHUNK_BYTES each) in a pull-based ReadableStream, so large
// files flow browser-ward with backpressure instead of being buffered whole.
// Powers fs/stream (Range playback) and fs/download; agentTempFileStream below
// drains and then deletes a temp file the agent produced (git results, folder zips).
import { callAgent } from "@/lib/rpc";

// Agent-side maxUploadChunkBytes — keep in sync with cli/src/rpc.js LIMITS.
export const DOWNLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

// What a stream asks for per RPC: below the cap, because a phone agent on a
// slow uplink took ~22s to send one 4 MiB chunk (5.7 MB of base64) — right at
// the default RPC timeout, and past it whenever playback and a download queue
// chunks on the same socket. 1 MiB keeps each answer a few seconds.
export const STREAM_CHUNK_BYTES = 1024 * 1024;
// A chunk may still wait behind others on the agent's one socket.
export const STREAM_CHUNK_TIMEOUT_MS = 120_000;

export function agentByteStream(
  driveId: string,
  driveSecret: string,
  path: string,
  start: number,
  endExclusive: number,
): ReadableStream<Uint8Array> {
  let offset = start;
  // The version the first chunk came from (agents that report it: the CLI).
  // A later chunk from another version means the file was replaced while we
  // streamed — end with an error rather than hand out a splice of two files.
  let version: string | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= endExclusive) { controller.close(); return; }
      const length = Math.min(STREAM_CHUNK_BYTES, endExclusive - offset);
      try {
        const r = await callAgent(driveId, driveSecret, { method: "download-chunk", path, offset, length }, { timeoutMs: STREAM_CHUNK_TIMEOUT_MS }) as
          { data: string; eof: boolean; mtimeMs?: number; size?: number };
        if (typeof r.mtimeMs === "number" && typeof r.size === "number") {
          const v = `${r.mtimeMs}:${r.size}`;
          if (version === null) version = v;
          else if (v !== version) { controller.error(new Error("file changed during download")); return; }
        }
        const buf = Buffer.from(r.data, "base64");
        if (buf.length === 0) { controller.close(); return; } // unexpected EOF (file shrank)
        offset += buf.length;
        controller.enqueue(new Uint8Array(buf));
        if (r.eof && offset < endExclusive) controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
}

/**
 * Streams a temp file the agent wrote for one response (a git result under
 * .aindrive/uploads/git/, a folder zip under .aindrive/uploads/zip/) and
 * deletes it when the stream ends — on completion, error or cancel alike, so a
 * client that goes away mid-download leaves nothing behind. `size` is the
 * byte count the producing RPC reported.
 */
export function agentTempFileStream(driveId: string, driveSecret: string, srcPath: string, size: number): ReadableStream<Uint8Array> {
  let offset = 0;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    callAgent(driveId, driveSecret, { method: "delete", path: srcPath }).catch(() => {});
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= size) { controller.close(); cleanup(); return; }
      try {
        const length = Math.min(STREAM_CHUNK_BYTES, size - offset);
        const r = await callAgent(driveId, driveSecret, { method: "download-chunk", path: srcPath, offset, length }, { timeoutMs: STREAM_CHUNK_TIMEOUT_MS });
        const buf = Buffer.from(r.data, "base64");
        if (buf.length === 0) { controller.close(); cleanup(); return; }
        offset += buf.length;
        controller.enqueue(new Uint8Array(buf));
        if (r.eof || offset >= size) { controller.close(); cleanup(); }
      } catch (e) { cleanup(); controller.error(e); }
    },
    cancel() { cleanup(); },
  });
}
