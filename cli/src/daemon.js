// Background ("detached") agent management. The serving agent is a long-lived
// process (the live web↔filesystem bridge), so `aindrive -d` re-spawns it
// detached with output to a logfile and records its pid, returning the
// terminal. `stop` / `status` / `logs` manage the running agent. State lives
// in the served folder's .aindrive/ (same place as config.json) so it's
// per-drive — you can background several folders independently.
import { spawn } from "node:child_process";
import {
  openSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync,
  statSync, watch, createReadStream,
} from "node:fs";
import { join, resolve } from "node:path";

function metaDir(dir) {
  const d = join(resolve(dir), ".aindrive");
  if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}
export function pidFile(dir) { return join(metaDir(dir), "agent.pid"); }
export function logFile(dir) { return join(metaDir(dir), "agent.log"); }

export function readPid(dir) {
  const f = join(resolve(dir), ".aindrive", "agent.pid");
  if (!existsSync(f)) return null;
  const pid = parseInt(readFileSync(f, "utf8").trim(), 10);
  return Number.isFinite(pid) ? pid : null;
}

/** True if a process with this pid exists (EPERM = exists but not ours). */
export function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

/** The live agent's pid for this folder, or null (clears a stale pidfile). */
export function runningPid(dir) {
  const pid = readPid(dir);
  if (pid && isAlive(pid)) return pid;
  if (pid) clearPid(dir); // stale (process died without cleanup)
  return null;
}

export function writePid(dir, pid) { writeFileSync(pidFile(dir), String(pid), { mode: 0o600 }); }
export function clearPid(dir) { try { rmSync(join(resolve(dir), ".aindrive", "agent.pid")); } catch {} }

/**
 * Re-spawn THIS binary to serve `dir` in the background. The child runs the
 * normal foreground serve (AINDRIVE_DETACHED marks it so the default action
 * doesn't re-detach), with stdout/stderr appended to the logfile. The parent
 * records the child's pid and returns immediately.
 */
export function startDetached(dir, childArgv) {
  const existing = runningPid(dir);
  if (existing) return { already: true, pid: existing };
  const lf = logFile(dir);
  const fd = openSync(lf, "a");
  const child = spawn(process.execPath, [process.argv[1], ...childArgv], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, AINDRIVE_DETACHED: "1" },
  });
  writePid(dir, child.pid);
  child.unref();
  return { pid: child.pid, logFile: lf };
}

/** SIGTERM the background agent (agent.js handles graceful shutdown). */
export function stop(dir) {
  const pid = runningPid(dir);
  if (!pid) { clearPid(dir); return { running: false }; }
  try { process.kill(pid, "SIGTERM"); } catch {}
  clearPid(dir);
  return { running: true, pid };
}

/** Portable `tail -f` of the agent logfile until Ctrl+C. */
export async function followLogs(dir) {
  const lf = logFile(dir);
  const pid = runningPid(dir);
  console.log(`\n  ${lf}${pid ? `  (agent running, pid ${pid})` : "  (agent not running)"}`);
  console.log("  — Ctrl+C to stop following —\n");
  if (!existsSync(lf)) { console.log("  (no log output yet)"); }
  let pos = existsSync(lf) ? statSync(lf).size : 0;
  // Print the last ~4 KB so the user sees recent context.
  if (pos > 0) {
    const start = Math.max(0, pos - 4096);
    await new Promise((res) => createReadStream(lf, { start, end: pos })
      .on("data", (c) => process.stdout.write(c)).on("end", res).on("error", res));
  }
  if (!existsSync(lf)) return;
  // Follow appended bytes. fs.watch fires on writes; re-read from our cursor.
  watch(lf, () => {
    let size;
    try { size = statSync(lf).size; } catch { return; }
    if (size < pos) pos = 0; // truncated/rotated
    if (size > pos) {
      createReadStream(lf, { start: pos, end: size }).on("data", (c) => process.stdout.write(c));
      pos = size;
    }
  });
  await new Promise(() => {}); // run until SIGINT
}
