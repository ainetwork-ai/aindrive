#!/usr/bin/env node
/**
 * Single-package entry for `aindrive`.
 *
 * Two modes, dispatched on the first arg:
 *
 *   aindrive [folder] [--port N] [--no-open]
 *       → start the prebuilt Next.js standalone server (dist/server.js) on
 *         port 3737 (or --port). Open the browser. The user signs up,
 *         creates a drive, and can pair `folder` from another shell with
 *         `aindrive` (the bundled CLI agent — second mode below).
 *
 *   aindrive serve|login|status|rotate-token|...
 *       → forward to the bundled CLI agent (cli/src/main.js) so users get
 *         the same UX they'd get from `npm i -g @aindrive/cli`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = resolve(__dirname, "..");

const argv = process.argv.slice(2);
const cmd = argv[0];

if (cmd === "--help" || cmd === "-h" || cmd === "help") {
  printHelp();
  process.exit(0);
}

if (cmd === "--version" || cmd === "-V" || cmd === "version") {
  const pkg = JSON.parse(await import("node:fs/promises").then((m) => m.readFile(join(PKG_ROOT, "package.json"), "utf8")));
  console.log(pkg.version);
  process.exit(0);
}

const CLI_SUBCOMMANDS = new Set(["serve", "login", "status", "rotate-token"]);
if (CLI_SUBCOMMANDS.has(cmd)) {
  await runCli(argv);
} else {
  await runServer(argv);
}

// ────────────────────────────────────────────────────────────────────────────

async function runServer(args) {
  const opts = parseFlags(args);
  const folder = opts.positional[0] || ".";
  const port = Number(process.env.PORT || opts.port || 3737);

  const distServer = join(PKG_ROOT, "dist", "server.js");
  const devServer = join(PKG_ROOT, "web", "server.js");

  let entry;
  let cwd;
  if (existsSync(distServer)) {
    entry = distServer;
    cwd = join(PKG_ROOT, "dist");
  } else if (existsSync(devServer)) {
    console.error("aindrive: prebuilt dist/ not found, falling back to dev server");
    entry = devServer;
    cwd = join(PKG_ROOT, "web");
  } else {
    console.error("aindrive: no server found. Run `npm run build` first.");
    process.exit(1);
  }

  const env = {
    ...process.env,
    PORT: String(port),
    AINDRIVE_TARGET_FOLDER: resolve(folder),
  };

  const child = spawn(process.execPath, [entry], { stdio: "inherit", cwd, env });

  child.on("exit", (code) => process.exit(code ?? 0));
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));

  if (opts.open !== false) {
    await sleep(1500);
    const url = `http://localhost:${port}`;
    try {
      const { default: open } = await import("open");
      await open(url);
    } catch {
      console.log(`\n  → ${url}\n`);
    }
  }
}

async function runCli(args) {
  const cliEntry = join(PKG_ROOT, "cli", "src", "main.js");
  if (!existsSync(cliEntry)) {
    console.error("aindrive: bundled CLI not found at " + cliEntry);
    process.exit(1);
  }
  const { runCli: runCliMain } = await import(cliEntry);
  await runCliMain(args);
}

function parseFlags(args) {
  const out = { positional: [], port: null, open: true };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port" || a === "-p") out.port = Number(args[++i]);
    else if (a === "--no-open") out.open = false;
    else if (!a.startsWith("-")) out.positional.push(a);
  }
  return out;
}

function printHelp() {
  console.log(`aindrive — your local folder, served like Google Drive.

Usage:
  aindrive [folder]           Start the web server on http://localhost:3737
                              and open it in the browser.
  aindrive --port 4000        Use a custom port.
  aindrive --no-open          Don't auto-open the browser.

Bundled CLI subcommands (forwarded to the agent):
  aindrive login              Authenticate this machine.
  aindrive serve <folder>     Pair the folder + run the agent.
  aindrive status             Show drive id and connection state.
  aindrive rotate-token       Rotate the per-drive agent token.

  aindrive --version          Print version.
  aindrive --help             This message.
`);
}
