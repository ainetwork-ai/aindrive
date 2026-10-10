// lib/git-panel.ts: the pure state behind the git panel and the ▶ Run output —
// the reducer's running / success / failed / unavailable states, SSE parsing,
// which files are runnable, and the relative-time / duration labels.
import { parseRunEvent, describe, it, expect } from "vitest";
import {
  RUN_IDLE, reduceRun, parseRunEvent, splitSse, runLanguageFor, relativeTime, formatDuration, shortSha, type RunEvent,
} from "../git-panel";

const play = (events: RunEvent[]) => events.reduce(reduceRun, RUN_IDLE);

describe("reduceRun", () => {
  it("running → success with exit 0, keeping the output in order", () => {
    const s = play([{ type: "start", at: 1000 }, { type: "stdout", text: "a" }, { type: "stderr", text: "warn" }, { type: "stdout", text: "b" }]);
    expect(s.status).toBe("running");
    expect(s.chunks.map((c) => c.stream + ":" + c.text)).toEqual(["stdout:a", "stderr:warn", "stdout:b"]);
    const done = reduceRun(s, { type: "exit", code: 0, durationMs: 42 });
    expect(done).toMatchObject({ status: "success", exitCode: 0, durationMs: 42 });
  });
  it("a non-zero exit is failed; the duration falls back to wall-clock", () => {
    const s = play([{ type: "start", at: 1000 }, { type: "exit", code: 1, at: 3500 }]);
    expect(s).toMatchObject({ status: "failed", exitCode: 1, durationMs: 2500 });
  });
  it("error and unavailable are terminal failure states", () => {
    expect(play([{ type: "start", at: 0 }, { type: "error", message: "boom" }])).toMatchObject({ status: "failed", error: "boom" });
    expect(play([{ type: "start", at: 0 }, { type: "unavailable" }])).toMatchObject({ status: "unavailable", error: "runner unavailable" });
  });
  it("a new start clears the previous run", () => {
    const s = play([{ type: "start", at: 0 }, { type: "stdout", text: "old" }, { type: "exit", code: 0 }, { type: "start", at: 9 }]);
    expect(s).toEqual({ ...RUN_IDLE, status: "running", startedAt: 9 });
  });
});

describe("SSE parsing", () => {
  it("accepts ainize's JSON-string chunks, {code, ms} exits and string errors", () => {
    expect(parseRunEvent('event: stdout\ndata: "=== rank ===\\n  1. 0.69 a6\\n"')).toEqual({ type: "stdout", text: "=== rank ===\n  1. 0.69 a6\n" });
    expect(parseRunEvent('event: exit\ndata: {"code":0,"ms":1315}')).toEqual({ type: "exit", code: 0, durationMs: 1315 });
    expect(parseRunEvent('event: error\ndata: "timeout after 120000ms"')).toEqual({ type: "error", message: "timeout after 120000ms" });
  });
  it("splits complete blocks and keeps the partial tail", () => {
    const { blocks, rest } = splitSse("event: stdout\ndata: {\"text\":\"x\"}\n\nevent: exit\ndata: {\"co");
    expect(blocks).toHaveLength(1);
    expect(rest).toBe("event: exit\ndata: {\"co");
  });
  it("maps the runner's four events and ignores others", () => {
    expect(parseRunEvent("event: stdout\ndata: {\"text\":\"hi\"}")).toEqual({ type: "stdout", text: "hi" });
    expect(parseRunEvent("event: stderr\ndata: {\"text\":\"e\"}")).toEqual({ type: "stderr", text: "e" });
    expect(parseRunEvent("event: exit\ndata: {\"code\":2,\"durationMs\":7}")).toEqual({ type: "exit", code: 2, durationMs: 7 });
    expect(parseRunEvent("event: error\ndata: {\"message\":\"timeout\"}")).toEqual({ type: "error", message: "timeout" });
    expect(parseRunEvent("event: ping\ndata: {}")).toBeNull();
    expect(parseRunEvent(": comment only")).toBeNull();
  });
});

describe("labels", () => {
  it("runnable extensions", () => {
    expect(runLanguageFor("main.py")).toBe("python");
    expect(runLanguageFor("src/app.JS")).toBe("node");
    expect(runLanguageFor("x.mjs")).toBe("node");
    expect(runLanguageFor("README.md")).toBeNull();
    expect(runLanguageFor("Makefile")).toBeNull();
  });
  it("relative time and duration", () => {
    const now = Date.parse("2026-10-10T12:00:00Z");
    expect(relativeTime("2026-10-10T11:59:50Z", now)).toBe("just now");
    expect(relativeTime("2026-10-10T11:55:00Z", now)).toBe("5m ago");
    expect(relativeTime("2026-10-10T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2026-10-08T12:00:00Z", now)).toBe("2d ago");
    expect(relativeTime("garbage", now)).toBe("");
    expect(formatDuration(420)).toBe("0.4s");
    expect(formatDuration(125_000)).toBe("2m 05s");
    expect(formatDuration(null)).toBe("");
    expect(shortSha("0123456789abcdef")).toBe("0123456");
  });
});
