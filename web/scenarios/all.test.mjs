import { test, describe, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { cases, cleanupTestDriveShares } from "./cases.mjs";

// After each case, sweep for any orphaned per-case agent processes: case #92
// (boot.mjs), case #96 (start-agent.mjs), and collab #118 (start-agent.mjs).
// Skip the harness global agent (HARNESS_AGENT_PID) — it is managed by
// global-setup.mjs teardown, not by per-case cleanup.
afterEach(async () => {
  // Revoke any paid shares left on the shared test drive: with the paid carve-out
  // a stale sale would 402 a later viewer's read / close (4402) their WS sub.
  await cleanupTestDriveShares();

  // global-setup.mjs publishes the harness agent PID so we don't kill it here.
  // ensureDrive() in cases.mjs publishes the suite (test-drive) agent PID.
  // Only sweep agents spawned within individual cases (#92 boot.mjs, #96/#118 start-agent.mjs).
  const harnessAgentPid = process.env.HARNESS_AGENT_PID
    ? parseInt(process.env.HARNESS_AGENT_PID, 10)
    : null;
  const suiteAgentPid = process.env.SUITE_AGENT_PID
    ? parseInt(process.env.SUITE_AGENT_PID, 10)
    : null;

  for (const pattern of ["start-agent.mjs", "boot.mjs"]) {
    try {
      const lines = execSync(
        `ps -eo pid,command | grep '${pattern}' | grep -v grep || true`,
      )
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean);
      for (const line of lines) {
        const pid = parseInt(line.trim().split(/\s+/)[0], 10);
        if (!Number.isFinite(pid) || pid <= 0) continue;
        // Don't kill the harness global agent — it lives across all test cases.
        if (harnessAgentPid && pid === harnessAgentPid) continue;
        // Don't kill the suite agent (spawned by ensureDrive()) — it lives across cases too.
        if (suiteAgentPid && pid === suiteAgentPid) continue;
        try { process.kill(pid, "SIGKILL"); } catch {}
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
