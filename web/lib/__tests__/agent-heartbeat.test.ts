import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-heartbeat-"));
const { startHeartbeat } = await import("../agents.js");

// An agent socket that stops answering pings (its laptop slept, its network
// dropped) never closes on its own: the server kept it as "connected", so the
// drive showed online and every request waited out the RPC timeout.
type FakeWs = EventEmitter & { OPEN: number; readyState: number; pings: number; terminated: number; ping(): void; terminate(): void };
function fakeWs(): FakeWs {
  const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, pings: 0, terminated: 0 }) as FakeWs;
  ws.ping = () => { ws.pings++; };
  ws.terminate = () => { ws.terminated++; ws.readyState = 3; ws.emit("close"); };
  return ws;
}

describe("startHeartbeat", () => {
  afterEach(() => vi.useRealTimers());

  it("pings on every beat and keeps an agent that answers", () => {
    vi.useFakeTimers();
    const ws = fakeWs();
    const beats: number[] = [];
    startHeartbeat(ws, { intervalMs: 20_000, onBeat: () => beats.push(1) });
    for (let i = 0; i < 5; i++) { vi.advanceTimersByTime(20_000); ws.emit("pong"); }
    expect(ws.pings).toBe(5);
    expect(ws.terminated).toBe(0);
    expect(beats.length).toBe(5);
  });

  it("drops an agent that missed a pong", () => {
    vi.useFakeTimers();
    const ws = fakeWs();
    startHeartbeat(ws, { intervalMs: 20_000 });
    vi.advanceTimersByTime(20_000); // ping, no pong
    vi.advanceTimersByTime(20_000); // still nothing → terminate
    expect(ws.terminated).toBe(1);
  });
});
