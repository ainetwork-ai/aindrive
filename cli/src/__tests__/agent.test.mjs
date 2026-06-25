// Characterization tests for the pure helpers in agent.js — agent-first
// migration safety net.
//
// toWsUrl + sanitize are pure (no IO); they were exported solely so this file
// can lock their behaviour before the agent.js structural refactor. The WS
// lifecycle (connectOnce) is NOT covered here — it hard-imports `ws` with no
// injection seam, so locking it needs a source change (deferred to the structure
// phase). Every assertion below was verified by probing the real module first.
import { describe, it, expect } from "vitest";
import { toWsUrl, sanitize } from "../agent.js";

describe("toWsUrl", () => {
  it("maps http:// to ws:// and builds the /api/agent/connect path", () => {
    expect(toWsUrl("http://localhost:3737", "d1"))
      .toBe("ws://localhost:3737/api/agent/connect?driveId=d1");
  });

  it("maps https:// to wss://", () => {
    expect(toWsUrl("https://x.com", "d1"))
      .toBe("wss://x.com/api/agent/connect?driveId=d1");
  });

  it("URL-encodes the driveId query param", () => {
    expect(toWsUrl("https://x.com", "a b/c?"))
      .toBe("wss://x.com/api/agent/connect?driveId=a%20b%2Fc%3F");
  });

  it("CURRENT BEHAVIOUR: an existing path on the server URL is dropped (the connect path is absolute)", () => {
    expect(toWsUrl("https://x.com/base/", "d1"))
      .toBe("wss://x.com/api/agent/connect?driveId=d1");
  });
});

describe("sanitize", () => {
  it("redacts an absolute path to <path>", () => {
    expect(sanitize("ENOENT: /Users/me/secret/file.txt missing"))
      .toBe("ENOENT: <path> missing");
  });

  it("collapses a fully path-like string to a single <path> (greedy match)", () => {
    expect(sanitize("/a/".repeat(200))).toBe("<path>");
  });

  it("maps empty / null / undefined to the literal 'error'", () => {
    expect(sanitize("")).toBe("error");
    expect(sanitize(null)).toBe("error");
    expect(sanitize(undefined)).toBe("error");
  });

  it("caps the result at 300 chars", () => {
    expect(sanitize("x".repeat(400))).toHaveLength(300);
  });
});
