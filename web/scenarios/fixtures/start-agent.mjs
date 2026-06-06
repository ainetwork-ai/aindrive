// Agent launcher shim for the scenario suite.
// Spawned by ensureDrive() and case #96/#118 as:
//   spawn("node", ["start-agent.mjs"], { cwd: SAMPLE })
// Reads .aindrive/config.json from cwd (= SAMPLE) and calls runAgent.
// server override: config.json is written by ensureDrive() with serverUrl: BASE,
// so the agent connects to the test server, not the hardcoded original.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve cli/src/agent.js repo-relatively from fixtures/ → ../../.. = repo root.
const _here = dirname(fileURLToPath(import.meta.url));
// fixtures/start-agent.mjs → fixtures/ → web/scenarios/ → web/ → repo root
const repoRoot = resolve(_here, "../../..");
const agentPath = resolve(repoRoot, "cli/src/agent.js");

const { runAgent } = await import(agentPath);

const cfgPath = resolve(process.cwd(), ".aindrive/config.json");
const drive = JSON.parse(readFileSync(cfgPath, "utf8"));
// drive.serverUrl is set by ensureDrive() to BASE (the test server).
const root = process.cwd();

await runAgent({ root, drive, server: drive.serverUrl });
