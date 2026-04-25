/**
 * N4.3 multi-device sync smoke test.
 *
 * Simulates two physical machines by starting TWO agent processes against the
 * SAME drive with TWO different sample folders. Sets a fake yjs entry on agent
 * A, then verifies it propagates to agent B via the sync protocol.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";

const DRIVE_ID = "rr5NDM0UQI4J";
const ROOT_A = "/tmp/aindrive-deviceA";
const ROOT_B = "/tmp/aindrive-deviceB";

// Fresh sample dirs
for (const root of [ROOT_A, ROOT_B]) {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, ".aindrive"), { recursive: true });
}

// Same drive config — simulates "same drive, two devices"
const driveConfig = JSON.parse(readFileSync("/mnt/newdata/git/aindrive/sample/.aindrive/config.json", "utf8"));
writeFileSync(join(ROOT_A, ".aindrive", "config.json"), JSON.stringify(driveConfig, null, 2));
writeFileSync(join(ROOT_B, ".aindrive", "config.json"), JSON.stringify(driveConfig, null, 2));

// Seed device A with a yjs entry
const docId = "test-doc-id-multi-device";
const fakePayload = Buffer.from("hello-from-deviceA");
const dbA = new Database(join(ROOT_A, ".aindrive", "willow.db"));
dbA.exec(`
  CREATE TABLE IF NOT EXISTS yjs_entries (
    doc_id TEXT NOT NULL, seq INTEGER NOT NULL,
    payload BLOB NOT NULL, digest TEXT NOT NULL,
    created_at INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'update',
    PRIMARY KEY (doc_id, seq)
  );
`);
const digest = createHash("sha256").update(fakePayload).digest("base64url");
dbA.prepare("INSERT INTO yjs_entries (doc_id, seq, payload, digest, created_at, kind) VALUES (?, ?, ?, ?, ?, 'update')").run(docId, 1, fakePayload, digest, Date.now());
dbA.close();
console.log(`seeded device A with entry digest=${digest.slice(0, 16)}…`);

// Start both agents
function startAgent(root, label) {
  // Write a tiny ESM bootstrap script per device
  const boot = join(root, "boot.mjs");
  writeFileSync(boot, `
import { readFileSync } from "node:fs";
import { runAgent } from "/mnt/newdata/git/aindrive/cli/src/agent.js";
const drive = JSON.parse(readFileSync("${root}/.aindrive/config.json", "utf8"));
runAgent({ root: "${root}", drive, server: drive.serverUrl });
`);
  const proc = spawn("node", [boot], { stdio: ["ignore", "pipe", "pipe"], cwd: root });
  proc.stdout.on("data", (d) => process.stdout.write(`  [${label}] ${d}`));
  proc.stderr.on("data", (d) => process.stderr.write(`  [${label}!] ${d}`));
  return proc;
}

const procA = startAgent(ROOT_A, "A");
await sleep(2000);
const procB = startAgent(ROOT_B, "B");
console.log("\nwaiting for sync (35s)…");
await sleep(35_000);

procA.kill("SIGTERM");
procB.kill("SIGTERM");
await sleep(500);

// Check device B's willow.db
const dbB = new Database(join(ROOT_B, ".aindrive", "willow.db"));
const rows = dbB.prepare("SELECT seq, digest, LENGTH(payload) AS bytes FROM yjs_entries WHERE doc_id = ?").all(docId);
console.log(`\ndevice B yjs_entries for ${docId}:`, rows);
dbB.close();

const found = rows.some((r) => r.digest === digest);
if (found) {
  console.log("\n🎉 N4.3 multi-device sync PASSED — entry replicated A → B");
} else {
  console.error("\n❌ N4.3 FAILED — digest not found on device B");
  process.exit(1);
}
