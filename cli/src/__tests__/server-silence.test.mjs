// watchServerSilence: the server pings every 20s. A connection that goes
// half-open (network blip, laptop sleep, a proxy dropping it without a close)
// never fires "close", so without this the agent stays offline for good.
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { watchServerSilence } from "../agent.js";

function fakeWs() {
  const ws = new EventEmitter();
  ws.terminated = 0;
  ws.terminate = () => { ws.terminated++; };
  return ws;
}

describe("watchServerSilence", () => {
  afterEach(() => vi.useRealTimers());

  it("terminates a connection the server has gone silent on", () => {
    vi.useFakeTimers();
    const ws = fakeWs();
    watchServerSilence(ws, { limitMs: 70_000, checkMs: 10_000 });
    vi.advanceTimersByTime(80_000);
    expect(ws.terminated).toBe(1);
  });

  it("keeps a connection whose server keeps pinging", () => {
    vi.useFakeTimers();
    const ws = fakeWs();
    watchServerSilence(ws, { limitMs: 70_000, checkMs: 10_000 });
    for (let t = 0; t < 10; t++) { vi.advanceTimersByTime(20_000); ws.emit("ping"); }
    expect(ws.terminated).toBe(0);
  });

  it("any message from the server also counts as alive", () => {
    vi.useFakeTimers();
    const ws = fakeWs();
    watchServerSilence(ws, { limitMs: 70_000, checkMs: 10_000 });
    for (let t = 0; t < 10; t++) { vi.advanceTimersByTime(20_000); ws.emit("message", "{}"); }
    expect(ws.terminated).toBe(0);
  });

  it("stops watching once the connection closes", () => {
    vi.useFakeTimers();
    const ws = fakeWs();
    watchServerSilence(ws, { limitMs: 70_000, checkMs: 10_000 });
    ws.emit("close");
    vi.advanceTimersByTime(200_000);
    expect(ws.terminated).toBe(0);
  });
});
