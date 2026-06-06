import { test, describe, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { cases } from "./cases.mjs";

// After each case, sweep for any orphaned per-case agent processes: case #92
// (boot.mjs), case #96 (start-agent.mjs), and collab #118 (start-agent.mjs).
// The globalSetup global agent has its own PID captured in global-setup.mjs
// and is not affected by this sweep.
afterEach(async () => {
  for (const pattern of ["start-agent.mjs", "boot.mjs"]) {
    try {
      const lines = execSync(
        `ps -eo pid,cmd | grep '${pattern}' | grep -v grep || true`,
      )
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean);
      for (const line of lines) {
        const pid = parseInt(line.trim().split(/\s+/)[0], 10);
        if (Number.isFinite(pid) && pid > 0) {
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
      }
    } catch {}
  }
});

describe("aindrive scenarios", () => {
  for (const c of cases) {
    const fn = c.skip ? test.skip : test;
    fn(`#${String(c.id).padStart(3, "0")} ${c.name}`, async () => {
      await c.run();
    }, 120_000);
  }
});
