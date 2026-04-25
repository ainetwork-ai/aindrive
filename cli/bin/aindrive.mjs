#!/usr/bin/env node
import { runCli } from "../src/main.js";

runCli(process.argv.slice(2)).catch((err) => {
  console.error("aindrive:", err?.message || err);
  process.exit(1);
});
