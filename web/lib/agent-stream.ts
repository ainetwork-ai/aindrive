// Byte-range streaming FROM the agent: wraps sequential download-chunk RPCs
// (4 MiB each — the agent-side cap) in a pull-based ReadableStream, so large
// files flow browser-ward with backpressure instead of being buffered whole.
// Powers fs/stream (Range playback) and fs/download.
import { callAgent } from "@/lib/rpc";

// Agent-side maxUploadChunkBytes — keep in sync with cli/src/rpc.js LIMITS.
export const DOWNLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

export function agentByteStream(
  driveId: string,
  driveSecret: string,
  path: string,
  start: number,
  endExclusive: number,
): ReadableStream<Uint8Array> {
  let offset = start;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= endExclusive) { controller.close(); return; }
      const length = Math.min(DOWNLOAD_CHUNK_BYTES, endExclusive - offset);
      try {
        const r = await callAgent(driveId, driveSecret, { method: "download-chunk", path, offset, length }) as
          { data: string; eof: boolean };
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
