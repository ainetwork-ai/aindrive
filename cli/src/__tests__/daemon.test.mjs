import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  readPid, writePid, clearPid, runningPid, isAlive, startDetached,
} from "../daemon.js";

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "aindrive-daemon-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("daemon pid state", () => {
  it("writes / reads / clears a pidfile", () => {
    expect(readPid(dir)).toBeNull();
    writePid(dir, 12345);
    expect(readPid(dir)).toBe(12345);
    clearPid(dir);
    expect(readPid(dir)).toBeNull();
  });

  it("isAlive: this process yes, an impossible pid no", () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(2147483646)).toBe(false);
    expect(isAlive(null)).toBe(false);
  });

  it("runningPid clears a stale pidfile (dead process)", () => {
    writePid(dir, 2147483646); // not a live process
    expect(runningPid(dir)).toBeNull();
    expect(readPid(dir)).toBeNull(); // stale entry was cleared
  });

  it("runningPid returns a live pid (this process)", () => {
    writePid(dir, process.pid);
    expect(runningPid(dir)).toBe(process.pid);
  });

  it("startDetached is a no-op when an agent is already running", () => {
    writePid(dir, process.pid); // pretend an agent is alive
    const res = startDetached(dir, [dir]);
    expect(res.already).toBe(true);
    expect(res.pid).toBe(process.pid);
  });
});

describe("daemon end-to-end (detached child)", () => {
  it("spawns a detached child that records its pid, then stops it", () => {
    // A minimal long-lived child stands in for the real serve loop: it writes
    // its own pid via the same helper and idles. Verifies the spawn/pidfile/
    // kill cycle without needing a server.
    const fakeAgent = join(dir, "fake-agent.mjs");
    writeFileSync(fakeAgent, `
      import { writePid } from ${JSON.stringify(join(process.cwd(), "src/daemon.js"))};
      writePid(${JSON.stringify(dir)}, process.pid);
      setInterval(() => {}, 1 << 30);
    `);
    const child = spawnSync(process.execPath, ["-e", `
      import("node:child_process").then(({ spawn }) => {
        const c = spawn(process.execPath, [${JSON.stringify(fakeAgent)}], { detached: true, stdio: "ignore" });
        c.unref();
        setTimeout(() => process.exit(0), 300);
      });
    `], { timeout: 5000 });
    expect(child.status).toBe(0);
    // child wrote its pid; it should be alive
    const pid = readPid(dir);
    expect(pid).toBeTruthy();
    expect(isAlive(pid)).toBe(true);
    // clean up the detached grandchild
    try { process.kill(pid, "SIGTERM"); } catch {}
  });
});
