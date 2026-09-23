import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const calls = [];
vi.mock("../api.js", () => ({
  apiFetch: async (server, p, opts) => {
    calls.push({ server, p, opts });
    return { agentToken: "N".repeat(48), driveSecret: "M".repeat(48) };
  },
}));
let creds = null;
vi.mock("../config.js", async (orig) => ({ ...(await orig()), readGlobalCreds: async () => creds }));

const { cmdRotate } = await import("../commands/rotate.js");
const { writeDriveConfig } = await import("../config.js");

let dir;
beforeEach(async () => {
  calls.length = 0;
  dir = mkdtempSync(path.join(tmpdir(), "rotate-cmd-"));
  await writeDriveConfig(dir, {
    driveId: "d1", serverUrl: "https://srv", agentToken: "old", driveSecret: "old",
    previousCredentials: { agentToken: "older", driveSecret: "older" },
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("aindrive rotate-token", () => {
  it("authenticates with the session cookie login stores, and persists the new pair", async () => {
    creds = { server: "https://srv", sessionCookie: "jwt123" };
    await cmdRotate({ positional: ["rotate-token", dir] });
    expect(calls).toEqual([{ server: "https://srv", p: "/api/drives/d1/rotate", opts: { method: "POST", headers: { cookie: "aindrive_session=jwt123" } } }]);
    const cfg = JSON.parse(readFileSync(path.join(dir, ".aindrive", "config.json"), "utf8"));
    expect(cfg).toMatchObject({ agentToken: "N".repeat(48), driveSecret: "M".repeat(48), driveId: "d1" });
    expect(cfg.previousCredentials).toBeUndefined(); // a stale live-rotation fallback must not survive
  });

  it("asks to log in when no session is stored", async () => {
    creds = { server: "https://srv" };
    await expect(cmdRotate({ positional: ["rotate-token", dir] })).rejects.toThrow(/login/);
  });
});
