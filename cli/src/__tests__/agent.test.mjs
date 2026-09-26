// Characterization tests for the pure helpers in agent.js — agent-first
// migration safety net.
//
// toWsUrl + sanitize are pure (no IO); they were exported solely so this file
// can lock their behaviour before the agent.js structural refactor. The WS
// lifecycle (connectOnce) is NOT covered here — it hard-imports `ws` with no
// injection seam, so locking it needs a source change (deferred to the structure
// phase). Every assertion below was verified by probing the real module first.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { toWsUrl, sanitize, agentHello } from "../agent.js";

const pkg = createRequire(import.meta.url)("../../package.json");

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

describe("agentHello (phone protocol v2)", () => {
  it("keeps the hostname and adds platform, appVersion and empty caps", () => {
    expect(agentHello({ hostname: "mbp" })).toMatchObject({
      type: "agent-hello", hostname: "mbp", platform: "cli", appVersion: pkg.version, caps: [],
    });
  });

  it("defaults the hostname to this machine's", () => {
    expect(agentHello().hostname).toBe(hostname());
  });

  it("lists every RPC method the agent answers, sorted and without duplicates", () => {
    const { methods } = agentHello();
    for (const m of ["list", "stat", "read", "write", "mkdir", "rename", "delete", "upload-chunk",
      "download-chunk", "yjs-write", "yjs-read", "yjs-stats", "agent-ask", "rotate-credentials"]) {
      expect(methods).toContain(m);
    }
    expect(methods).toEqual([...methods].sort());
    expect(new Set(methods).size).toBe(methods.length);
  });

  it("does not claim ask.v2: the LLM agent has no read-only mode yet", () => {
    expect(agentHello().caps).not.toContain("ask.v2");
  });

  it("is plain JSON", () => {
    const h = agentHello({ hostname: "x" });
    expect(JSON.parse(JSON.stringify(h))).toEqual(h);
  });
});
