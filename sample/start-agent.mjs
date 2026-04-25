import { readFileSync } from "node:fs";
import { runAgent } from "/mnt/newdata/git/aindrive/cli/src/agent.js";
const drive = JSON.parse(readFileSync(".aindrive/config.json", "utf8"));
await runAgent({ root: process.cwd(), drive, server: drive.serverUrl });
