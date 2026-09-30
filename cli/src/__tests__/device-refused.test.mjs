// A device the server refuses (plan 12.2, seen on a real CLI agent): removed
// from the web (4401 after a rotate) or its drive deleted (4410, then 4404).
// Before, the agent reconnected every second forever — one bcrypt compare per
// try on the server — and an agent that ran `aindrive rotate-token` itself had
// to be restarted to use its new key.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { refusalOf, reconnectWait } from "../agent.js";
import { adoptConfigOnDisk } from "../rotation.js";
import { writeDriveConfig } from "../config.js";

describe("refusalOf", () => {
  it("names the server's refusal codes and nothing else", () => {
    expect(refusalOf(4401)).toMatch(/no longer valid/);
    expect(refusalOf(4404)).toMatch(/no longer exists/);
    expect(refusalOf(4410)).toMatch(/deleted/);
    for (const c of [1000, 1001, 1006, 4400, undefined]) expect(refusalOf(c)).toBeNull();
  });
});

describe("reconnectWait", () => {
  it("keeps the quick schedule for ordinary drops", () => {
    expect([0, 1, 2, 3, 4, 9].map((a) => reconnectWait(a, false))).toEqual([1000, 2000, 4000, 8000, 15_000, 15_000]);
  });
  it("waits 30 s growing to 5 min once refused (at most ~20 tries an hour after the first)", () => {
    expect([0, 1, 2, 3, 9].map((a) => reconnectWait(a, true))).toEqual([30_000, 60_000, 120_000, 300_000, 300_000]);
  });
});

describe("adoptConfigOnDisk", () => {
  const OLD = { agentToken: "old-token-".padEnd(48, "x"), driveSecret: "old-secret-".padEnd(48, "y") };
  const NEW = { agentToken: "new-token-".padEnd(48, "a"), driveSecret: "new-secret-".padEnd(48, "b") };
  let root;
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "refused-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("takes a pair `aindrive rotate-token` wrote while this agent was serving", async () => {
    const drive = { driveId: "d1", serverUrl: "https://x", ...OLD };
    await writeDriveConfig(root, { ...drive, ...NEW });
    expect(await adoptConfigOnDisk({ root, drive })).toBe(true);
    expect(drive).toMatchObject(NEW);
  });

  it("does nothing when the config still has the refused pair (the device was removed)", async () => {
    const drive = { driveId: "d1", serverUrl: "https://x", ...OLD };
    await writeDriveConfig(root, drive);
    expect(await adoptConfigOnDisk({ root, drive })).toBe(false);
    expect(drive).toMatchObject(OLD);
  });

  it("ignores another drive's config or a missing one", async () => {
    const drive = { driveId: "d1", serverUrl: "https://x", ...OLD };
    expect(await adoptConfigOnDisk({ root, drive })).toBe(false);
    await writeDriveConfig(root, { driveId: "other", ...NEW });
    expect(await adoptConfigOnDisk({ root, drive })).toBe(false);
    expect(drive).toMatchObject(OLD);
  });
});

describe("waitForNewKey (while refused)", () => {
  it("returns as soon as the folder's config gets a new pair", async () => {
    const { waitForNewKey } = await import("../agent.js");
    let calls = 0;
    const t0 = Date.now();
    const got = await waitForNewKey({ root: "/x", drive: {}, ms: 5000, pollMs: 10, adopt: async () => ++calls >= 3 });
    expect(got).toBe(true);
    expect(calls).toBe(3);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it("waits the full time when nothing changes", async () => {
    const { waitForNewKey } = await import("../agent.js");
    const t0 = Date.now();
    expect(await waitForNewKey({ root: "/x", drive: {}, ms: 80, pollMs: 20, adopt: async () => false })).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(75);
  });
});
