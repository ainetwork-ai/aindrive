import { test } from "node:test";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentManager, driveUrlOf, parseLine } from "../agents.js";

test("parseLine reads the CLI's plain lines and pino JSON", () => {
  assert.deepEqual(parseLine("  waiting for approval…"), { state: "approve" });
  assert.deepEqual(parseLine("  https://aindrive.ainetwork.ai/cli-login/abc-123"), { loginUrl: "https://aindrive.ainetwork.ai/cli-login/abc-123" });
  assert.deepEqual(parseLine("  ✓ paired  https://x.test/d/D1"), { url: "https://x.test/d/D1", state: "connecting" });
  assert.deepEqual(parseLine('{"level":30,"msg":"connected","driveId":"D1"}'), { state: "online" });
  assert.deepEqual(parseLine('{"level":30,"msg":"reconnecting"}'), { state: "connecting" });
  assert.deepEqual(parseLine('{"level":50,"msg":"agent connection error","err":"ECONNREFUSED"}'), { state: "connecting", detail: "ECONNREFUSED" });
  assert.deepEqual(parseLine("aindrive: link expired or already used"), { state: "error", detail: "link expired or already used" });
  assert.equal(parseLine('{"msg":"rpc"}'), null);
  assert.equal(parseLine(""), null);
});

test("driveUrlOf reads the folder's pairing", () => {
  const d = mkdtempSync(join(tmpdir(), "aindrive-desk-"));
  assert.equal(driveUrlOf(d), null);
  mkdirSync(join(d, ".aindrive"));
  writeFileSync(join(d, ".aindrive", "config.json"), JSON.stringify({ serverUrl: "https://s.test", driveId: "D9" }));
  assert.equal(driveUrlOf(d), "https://s.test/d/D9");
});

/** a fake `aindrive`: prints what the real one does, then serves until killed */
function fakeCli(script) {
  const d = mkdtempSync(join(tmpdir(), "aindrive-fake-"));
  const f = join(d, "fake.mjs");
  writeFileSync(f, script);
  return f;
}

const until = (m, fn, ms = 5000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout: ${JSON.stringify(m.list())}`)), ms);
    const check = () => { if (fn(m.list()[0])) { clearTimeout(t); m.off("change", check); res(); } };
    m.on("change", check);
    check();
  });

test("an agent goes approve → online, pauses, and stops cleanly", async () => {
  const cli = fakeCli(`
    console.log("  https://s.test/cli-login/L1"); console.log("  waiting for approval…");
    setTimeout(() => { console.log("  ✓ paired  https://s.test/d/D1"); console.log(JSON.stringify({ msg: "connected" })); }, 100);
    setInterval(() => {}, 1000);
  `);
  const folder = mkdtempSync(join(tmpdir(), "aindrive-share-"));
  const m = new AgentManager({ spawn: (folder) => spawn(process.execPath, [cli], { cwd: folder, stdio: ["ignore", "pipe", "pipe"] }) });
  m.start(folder, { firstRun: true });
  await until(m, (f) => f?.state === "approve" && f.loginUrl === "https://s.test/cli-login/L1");
  await until(m, (f) => f?.state === "online" && f.url === "https://s.test/d/D1");
  m.stop(folder);
  await until(m, (f) => f?.state === "stopped");
  m.remove(folder);
  assert.equal(m.list().length, 0);
});

test("a folder that never paired waits for a retry instead of looping", async () => {
  const cli = fakeCli(`console.error("aindrive: link expired or already used"); process.exit(1);`);
  const folder = mkdtempSync(join(tmpdir(), "aindrive-share-"));
  const m = new AgentManager({ spawn: (folder) => spawn(process.execPath, [cli], { cwd: folder, stdio: ["ignore", "pipe", "pipe"] }) });
  m.start(folder);
  await until(m, (f) => f?.state === "error");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(m.list()[0].state, "error");
  assert.equal(m.list()[0].detail, "link expired or already used");
  await m.stopAll();
});

test("a paired folder whose agent dies is restarted", async () => {
  const folder = mkdtempSync(join(tmpdir(), "aindrive-share-"));
  mkdirSync(join(folder, ".aindrive"));
  writeFileSync(join(folder, ".aindrive", "config.json"), JSON.stringify({ url: "https://s.test/d/D2" }));
  const marker = join(folder, "runs");
  const cli = fakeCli(`
    import { appendFileSync, readFileSync } from "node:fs";
    appendFileSync(${JSON.stringify(marker)}, "x");
    if (readFileSync(${JSON.stringify(marker)}, "utf8").length < 2) process.exit(3);
    console.log(JSON.stringify({ msg: "connected" }));
    setInterval(() => {}, 1000);
  `);
  const m = new AgentManager({ spawn: (folder) => spawn(process.execPath, [cli], { cwd: folder, stdio: ["ignore", "pipe", "pipe"] }) });
  m.start(folder);
  await until(m, (f) => f?.state === "online", 8000);
  await m.stopAll();
});

test("a file is never started as a folder, and a missing folder waits instead of throwing", async () => {
  const d = mkdtempSync(join(tmpdir(), "aindrive-share-"));
  const file = join(d, "notes.txt");
  writeFileSync(file, "x");
  let spawned = 0;
  const m = new AgentManager({ spawn: () => { spawned++; throw new Error("should not spawn"); } });
  m.start(file);
  m.start(join(d, "gone"));
  assert.equal(spawned, 0);
  assert.deepEqual(m.list().map((f) => f.state), ["error", "error"]);
  await m.stopAll(100);
});

test("stopAll cancels pending restarts, and resume during shutdown respawns once", async () => {
  const folder = mkdtempSync(join(tmpdir(), "aindrive-share-"));
  mkdirSync(join(folder, ".aindrive"));
  writeFileSync(join(folder, ".aindrive", "config.json"), JSON.stringify({ url: "https://s.test/d/D3" }));
  const marker = join(folder, "runs");
  // serves until SIGTERM, then takes a moment to drain (like the real CLI)
  const cli = fakeCli(`
    import { appendFileSync } from "node:fs";
    appendFileSync(${JSON.stringify(marker)}, "x");
    console.log(JSON.stringify({ msg: "connected" }));
    process.on("SIGTERM", () => setTimeout(() => process.exit(0), 300));
    setInterval(() => {}, 1000);
  `);
  const m = new AgentManager({ spawn: (f) => spawn(process.execPath, [cli], { cwd: f, stdio: ["ignore", "pipe", "pipe"] }) });
  m.start(folder);
  await until(m, (f) => f?.state === "online");
  m.stop(folder);
  m.start(folder); // resumed before the old one exited
  await new Promise((r) => setTimeout(r, 1000));
  await until(m, (f) => f?.state === "online");
  const { readFileSync } = await import("node:fs");
  assert.equal(readFileSync(marker, "utf8"), "xx"); // exactly one respawn
  await m.stopAll();
  assert.equal(m.list()[0].state, "stopped");
});
