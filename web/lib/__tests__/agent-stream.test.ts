import { describe, it, expect, vi, beforeEach } from "vitest";

// A phone agent on a slow uplink took ~22s per 4 MiB chunk — right at the
// 25s RPC default — so playback and downloads from it died with "agent timeout".
const calls: { length: number; timeoutMs?: number }[] = [];
vi.mock("@/lib/rpc", () => ({
  callAgent: async (_d: string, _s: string, p: { offset: number; length: number }, opts: { timeoutMs?: number } = {}) => {
    calls.push({ length: p.length, timeoutMs: opts.timeoutMs });
    return { method: "download-chunk", data: Buffer.alloc(p.length, 1).toString("base64"), eof: false };
  },
}));
const { agentByteStream, STREAM_CHUNK_BYTES } = await import("../agent-stream");

describe("agentByteStream", () => {
  beforeEach(() => { calls.length = 0; });

  it("asks a slow agent for small chunks, each with a long timeout", async () => {
    const size = 3 * STREAM_CHUNK_BYTES + 10;
    const body = await new Response(agentByteStream("d", "s", "a.mp4", 0, size)).arrayBuffer();
    expect(body.byteLength).toBe(size);
    expect(calls.map((c) => c.length)).toEqual([STREAM_CHUNK_BYTES, STREAM_CHUNK_BYTES, STREAM_CHUNK_BYTES, 10]);
    expect(STREAM_CHUNK_BYTES).toBeLessThanOrEqual(1024 * 1024);
    for (const c of calls) expect(c.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });
});
