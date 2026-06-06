// Agent launcher shim for the scenario suite.
// Lives at <SAMPLE>/start-agent.mjs. SAMPLE is either the committed
// fixtures/sample/ dir or a tmp copy of it (Phase 2 harness).
// Spawned as: spawn("node", ["start-agent.mjs"], { cwd: SAMPLE })
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// fixtures/sample/ → fixtures/ → web/scenarios/ → web/ → repo root
const _here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(_here, "../../../..");
const agentPath = resolve(repoRoot, "cli/src/agent.js");

const { runAgent } = await import(agentPath);

const cfgPath = resolve(process.cwd(), ".aindrive/config.json");
const drive = JSON.parse(readFileSync(cfgPath, "utf8"));
const root = process.cwd();

await runAgent({ root, drive, server: drive.serverUrl });
