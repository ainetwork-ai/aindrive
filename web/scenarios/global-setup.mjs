/**
 * vitest globalSetup for the e2e scenario suite.
 *
 * Boot order:
 *   1. Pick a free port (bind net.Server to :0, read address, close).
 *   2. Create a per-run tmp AINDRIVE_DATA_DIR.
 *   3. Copy web/scenarios/fixtures/sample/ to a per-run tmp dir (AINDRIVE_SAMPLE_DIR)
 *      so tests don't mutate the committed fixture.
 *   4. Set AINDRIVE_BASE / AINDRIVE_WS_BASE / AINDRIVE_DATA_DIR / AINDRIVE_SAMPLE_DIR
 *      / AINDRIVE_REPO_ROOT in the RUNNER process.env (these are the env vars
 *      cases.mjs:16-17 read) so dbHandle() opens the same sqlite as the server.
 *   5. Spawn `node server.js` in dev mode (no NODE_ENV=production).
 *   6. Poll GET /api/readyz until 200 (retries past the ~2 s uptime gate).
 *   7. Bootstrap the sample drive (signup owner, POST /api/drives, write config.json).
 *   8. Boot the global sample agent via fixtures/sample/start-agent.mjs shim.
 *   9. Poll GET /api/healthz until agentsConnected >= 1.
 *  10. Teardown: SIGTERM→SIGKILL the server and agent process handles.
 */

import net from "node:net";
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// scenarios/ lives at <repo_root>/web/scenarios/
const REPO_ROOT  = resolve(__dirname, "../..");
const WEB_ROOT   = resolve(__dirname, "..");
// The committed sample fixture — we copy it to a tmp dir on each run.
const FIXTURE_SAMPLE = join(REPO_ROOT, "web", "scenarios", "fixtures", "sample");

/** Bind to :0, read the OS-assigned port, close. */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    srv.on("error", reject);
  });
}

/** Poll fn() until it returns truthy or timeout ms elapses. */
async function pollUntil(fn, { intervalMs = 500, timeoutMs = 60_000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch (e) {
      last = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${last ? ": " + last.message : ""}`);
}

let serverProc  = null;  // { handle, pid }
let agentProc   = null;  // { handle, pid }

export async function setup() {
  // 1. Free port — bind to :0, read the OS-assigned port, close.
  // Do NOT pass PORT=0 to server.js: it binds the configured PORT and
  // never reads server.address().port, so PORT=0 would be unroutable.
  const port = await pickFreePort();

  // 2. Per-run tmp AINDRIVE_DATA_DIR (server writes data.sqlite here).
  const dataDir = mkdtempSync(join(tmpdir(), "aindrive-e2e-data-"));

  // 3. Copy the committed fixture to a per-run tmp dir so tests can write
  //    .aindrive/config.json without dirtying the committed tree.
  const sampleDir = mkdtempSync(join(tmpdir(), "aindrive-e2e-sample-"));
  cpSync(FIXTURE_SAMPLE, sampleDir, { recursive: true });

  const base   = `http://127.0.0.1:${port}`;
  const wsBase = `ws://127.0.0.1:${port}`;

  // 4. Set runner process.env — must happen before any scenario file is
  //    imported, which is guaranteed because globalSetup runs before workers.
  //    Explicit assignment wins over any web/.env.local that load-env.js loaded
  //    in a prior dev session (load-env.js never overwrites already-set vars).
  process.env.AINDRIVE_DATA_DIR   = dataDir;
  process.env.AINDRIVE_BASE       = base;        // cases.mjs:17 reads AINDRIVE_BASE
  process.env.AINDRIVE_WS_BASE    = wsBase;      // cases.mjs:18 + collab/emergent/trace
  process.env.AINDRIVE_SAMPLE_DIR = sampleDir;   // paths.mjs:13 reads AINDRIVE_SAMPLE_DIR
  process.env.AINDRIVE_REPO_ROOT  = REPO_ROOT;   // start-agent.mjs uses this for in-tmp-dir spawns
  // Legacy aliases for any ad-hoc tooling that reads the bare names.
  process.env.BASE                = base;
  process.env.WS_BASE             = wsBase;

  // 5. Spawn server in dev mode.
  //    - No NODE_ENV=production: boot-checks.js:8 returns early in dev;
  //      env.ts auto-creates session secret and defaults publicUrl.
  //    - PORT=<free port> so server.js:19 picks it up.
  //    - AINDRIVE_DATA_DIR + AINDRIVE_DEV_BYPASS_X402=1 for test mode.
  const serverEnv = {
    ...process.env,
    PORT:                     String(port),
    AINDRIVE_DATA_DIR:        dataDir,
    AINDRIVE_DEV_BYPASS_X402: "1",
    NODE_ENV:                 "development",
  };

  const serverHandle = spawn("node", ["server.js"], {
    cwd:      WEB_ROOT,
    env:      serverEnv,
    detached: false,
    stdio:    ["ignore", "pipe", "pipe"],
  });

  serverProc = { handle: serverHandle, pid: serverHandle.pid };
  serverHandle.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
  serverHandle.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  serverHandle.on("exit", (code, sig) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(`[server] exited with code ${code} signal ${sig}\n`);
    }
  });

  // 6. Poll /api/readyz — retries past the ~2 s uptime gate (readyz returns 503
  //    while process.uptime() < 2). 60 s total covers slow next-dev compile.
  console.log(`[harness] waiting for server on ${base}/api/readyz ...`);
  await pollUntil(
    async () => {
      const r = await fetch(`${base}/api/readyz`);
      return r.status === 200;
    },
    { intervalMs: 500, timeoutMs: 60_000, label: "/api/readyz 200" },
  );
  console.log("[harness] /api/readyz OK");

  // 7. Bootstrap the sample drive so start-agent.mjs has a config.json to read.
  //    We replicate minimal ensureDrive() logic here rather than importing
  //    cases.mjs (which registers 91 vitest tests as a side-effect).
  //
  //    Use a unique x-forwarded-for to avoid sharing the "anon" rate-limit bucket
  //    with the ~22 suite signups that each use their own x-forwarded-for.
  const ownerEmail    = `harness-${Date.now()}@example.com`;
  const ownerPassword = "harnesspass1234";

  async function jsonPost(path, body, cookie, extraHeaders = {}) {
    const headers = { "content-type": "application/json", ...extraHeaders };
    if (cookie) headers.cookie = cookie;
    const r = await fetch(`${base}${path}`, {
      method: "POST", headers, body: JSON.stringify(body),
    });
    const text = await r.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: r.status, body: parsed, headers: r.headers };
  }

  const signupR = await jsonPost(
    "/api/auth/signup",
    { email: ownerEmail, name: "Harness Owner", password: ownerPassword },
    undefined,
    { "x-forwarded-for": "10.255.255.254" },
  );
  if (signupR.status !== 200) {
    throw new Error(`harness owner signup failed (${signupR.status}): ${JSON.stringify(signupR.body)}`);
  }
  const ownerCookie = signupR.headers.get("set-cookie")?.split(";")[0];
  if (!ownerCookie) throw new Error("harness owner signup: no session cookie returned");

  const driveR = await jsonPost(
    "/api/drives",
    { name: "harness-sample" },
    ownerCookie,
  );
  if (driveR.status !== 200) {
    throw new Error(`harness drive creation failed (${driveR.status}): ${JSON.stringify(driveR.body)}`);
  }
  const drivePayload = driveR.body;  // { driveId, agentToken, driveSecret, serverUrl, url }

  // Write config.json to sampleDir/.aindrive/ so start-agent.mjs can read it.
  // Override serverUrl with the actual test-server base (createDrive returns
  // env.publicUrl which may be localhost:3737 in dev mode).
  mkdirSync(join(sampleDir, ".aindrive"), { recursive: true });
  writeFileSync(
    join(sampleDir, ".aindrive", "config.json"),
    JSON.stringify(
      { ...drivePayload, serverUrl: base, url: `${base}/d/${drivePayload.driveId}`, pairedAt: Date.now() },
      null, 2,
    ),
  );

  // 8. Spawn the agent shim from the tmp sampleDir.
  //    The shim (fixtures/sample/start-agent.mjs, copied to sampleDir) reads
  //    .aindrive/config.json and calls runAgent.
  //    Pass AINDRIVE_REPO_ROOT so the shim can resolve cli/src/agent.js even
  //    when cwd is a tmp dir outside the repo (import.meta.url fallback would
  //    otherwise compute the wrong repo root).
  const shimPath = join(sampleDir, "start-agent.mjs");
  const agentHandle = spawn(
    "node",
    [shimPath],
    {
      cwd:      sampleDir,
      env:      { ...process.env, AINDRIVE_REPO_ROOT: REPO_ROOT },
      detached: false,
      stdio:    ["ignore", "pipe", "pipe"],
    },
  );
  agentProc = { handle: agentHandle, pid: agentHandle.pid };
  // Publish the harness agent PID so all.test.mjs afterEach sweep can skip it.
  process.env.HARNESS_AGENT_PID = String(agentHandle.pid);
  agentHandle.stdout.on("data", (d) => process.stdout.write(`[agent] ${d}`));
  agentHandle.stderr.on("data", (d) => process.stderr.write(`[agent] ${d}`));
  agentHandle.on("exit", (code, sig) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(`[agent] exited with code ${code} signal ${sig}\n`);
    }
  });

  // 9. Poll /api/healthz until agentsConnected >= 1.
  //    /api/readyz has no agent awareness; /api/healthz:7-8 reads globalThis.__aindrive_agent_map.size.
  console.log("[harness] waiting for agent to connect (GET /api/healthz agentsConnected>=1) ...");
  await pollUntil(
    async () => {
      const r = await fetch(`${base}/api/healthz`);
      if (r.status !== 200) return false;
      const body = await r.json();
      return body.agentsConnected >= 1;
    },
    { intervalMs: 1_000, timeoutMs: 30_000, label: "/api/healthz agentsConnected>=1" },
  );
  console.log("[harness] agent connected. Harness ready.");

  // Expose harness credentials to tests via env.
  // cases.mjs reads AINDRIVE_BASE / AINDRIVE_WS_BASE / AINDRIVE_DATA_DIR (already set above).
  process.env.HARNESS_OWNER_COOKIE = ownerCookie;
  process.env.HARNESS_DRIVE_ID     = drivePayload.driveId;
  process.env.HARNESS_AGENT_TOKEN  = drivePayload.agentToken;
}

export async function teardown() {
  // Kill agent first (it has an open WS to the server), then the server.
  // SIGTERM → wait up to 5 s → SIGKILL.
  async function killProc(name, proc) {
    if (!proc) return;
    const { handle, pid } = proc;
    if (!pid) return;
    console.log(`[harness] terminating ${name} (pid ${pid}) ...`);
    try {
      handle.kill("SIGTERM");
      await Promise.race([
        new Promise((r) => handle.once("exit", r)),
        sleep(5_000),
      ]);
    } catch {}
    // Force-kill if still alive.
    try { process.kill(pid, "SIGKILL"); } catch {}
    try { handle.kill("SIGKILL"); } catch {}
    console.log(`[harness] ${name} done.`);
  }

  // Sweep any lingering `start-agent.mjs` processes. The suite agent is spawned
  // by ensureDrive() (cases.mjs) in the vitest WORKER process, so its PID never
  // reaches this main-process teardown via env (workers are forked, env doesn't
  // propagate back). A ps-based sweep is the only reliable cross-process signal.
  // SIGTERM → wait up to 5 s → SIGKILL. Killing the already-dead harness agent
  // again is harmless.
  function listAgentPids() {
    try {
      return execSync("ps -eo pid,command | grep 'start-agent.mjs' | grep -v grep || true")
        .toString().trim().split("\n").filter(Boolean)
        .map((l) => parseInt(l.trim().split(/\s+/)[0], 10))
        .filter((pid) => Number.isFinite(pid) && pid > 0);
    } catch { return []; }
  }

  async function sweepSuiteAgents() {
    let pids = listAgentPids();
    if (pids.length === 0) return;
    console.log(`[harness] sweeping ${pids.length} lingering start-agent.mjs proc(s): ${pids.join(", ")}`);
    for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch {} }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && listAgentPids().length > 0) {
      await sleep(200);
    }
    for (const pid of listAgentPids()) { try { process.kill(pid, "SIGKILL"); } catch {} }
    console.log("[harness] suite agent sweep done.");
  }

  await killProc("agent",  agentProc);
  await sweepSuiteAgents();
  await killProc("server", serverProc);
}
