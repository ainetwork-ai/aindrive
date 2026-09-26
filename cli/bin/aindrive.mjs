#!/usr/bin/env node
import { runCli } from "../src/main.js";
import { parentPortAskBridge, setAskBridge } from "../src/rpc.js";

// Inside the Mac app (an Electron utility process) a folder's `agent-ask` is answered by the app's
// on-device agent over the parent port, not by the CLI's LLM agent (desktop/src/main.js).
if (process.env.AINDRIVE_ASK_VIA_PARENT === "1" && process.parentPort) setAskBridge(parentPortAskBridge(process.parentPort));

runCli(process.argv.slice(2)).catch((err) => {
  console.error("aindrive:", err?.message || err);
  process.exit(1);
});
