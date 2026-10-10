import { describe, it, expect, vi, beforeEach } from "vitest";

// A phone agent on a slow uplink took ~22s per 4 MiB chunk — right at the
// 25s RPC default — so playback and downloads from it died with "agent timeout".
const calls: { length: number; timeoutMs?: number }[] = [];
// Plan 12.3: what the agent says about the file each chunk came from (the CLI
// reports mtimeMs/size; phone agents report nothing).
let versionOf: (n: number) => { mtimeMs?: number; size?: number } = () => ({});
vi.mock("@/lib/rpc", () => ({
  callAgent: async (_d: string, _s: string, p: { offset: number; length: number }, opts: { timeoutMs?: number } = {}) => {
    calls.push({ length: p.length, timeoutMs: opts.timeoutMs });
    return { method: "download-chunk", data: Buffer.alloc(p.length, 1).toString("base64"), eof: false, ...versionOf(calls.length) };
  },
}));
const { agentByteStream, STREAM_CHUNK_BYTES } = await import("../agent-stream");

describe("agentByteStream", () => {
  beforeEach(() => { calls.length = 0; versionOf = () => ({}); });

  it("asks a slow agent for small chunks, each with a long timeout", async () => {
    const size = 3 * STREAM_CHUNK_BYTES + 10;
    const body = await new Response(agentByteStream("d", "s", "a.mp4", 0, size)).arrayBuffer();
    expect(body.byteLength).toBe(size);
    expect(calls.map((c) => c.length)).toEqual([STREAM_CHUNK_BYTES, STREAM_CHUNK_BYTES, STREAM_CHUNK_BYTES, 10]);
    expect(STREAM_CHUNK_BYTES).toBeLessThanOrEqual(1024 * 1024);
    for (const c of calls) expect(c.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });

  it("ends with an error when the file is replaced mid-stream (never splices two versions)", async () => {
    versionOf = (n) => ({ mtimeMs: n < 3 ? 100 : 200, size: 5 * STREAM_CHUNK_BYTES });
    const size = 4 * STREAM_CHUNK_BYTES;
    await expect(new Response(agentByteStream("d", "s", "a.bin", 0, size)).arrayBuffer()).rejects.toThrow(/changed during download/);
    expect(calls.length).toBe(3);
  });

  it("streams through when every chunk names the same version", async () => {
    versionOf = () => ({ mtimeMs: 100, size: 2 * STREAM_CHUNK_BYTES });
    const body = await new Response(agentByteStream("d", "s", "a.bin", 0, 2 * STREAM_CHUNK_BYTES)).arrayBuffer();
    expect(body.byteLength).toBe(2 * STREAM_CHUNK_BYTES);
  });
});
