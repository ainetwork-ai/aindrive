import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { Command } from "commander";
import { cmdLogin } from "./commands/login.js";
import { cmdServe } from "./commands/serve.js";
import { cmdRotate } from "./commands/rotate.js";
import { cmdStatus } from "./commands/status.js";
import { cmdMcp } from "./commands/mcp.js";
import { cmdStop } from "./commands/stop.js";
import { cmdLogs } from "./commands/logs.js";
import { startDetached } from "./daemon.js";
import { readGlobalCreds, readDriveConfig } from "./config.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const DEFAULT_SERVER = process.env.AINDRIVE_SERVER || "https://aindrive.ainetwork.ai";

export async function runCli(argv) {
  const program = new Command();

  program
    .name("aindrive")
    .description("connect a local folder to your aindrive server")
    .version(version, "--version")
    .addHelpCommand(false);

  // Global options shared by all subcommands
  program
    .option("--server <url>", "server URL", DEFAULT_SERVER)
    .option("--name <name>", "name for this drive on first pairing")
    .option("-d, --detach", "serve in the background (use `aindrive stop`/`logs`/`status`)")
    .option("--no-open", "do not open the browser");

  // Default command: serve a folder (auto-login on first use, or when
  // --server points somewhere different from the saved credentials)
  program
    .argument("[folder]", "folder to connect (default: .)")
    .action(async (folder, opts) => {
      const resolvedFolder = folder || ".";
      const dir = resolve(resolvedFolder);
      if (!existsSync(dir)) throw new Error(`folder does not exist: ${dir}`);
      const args = buildArgs(opts, []);
      const drive = await readDriveConfig(dir);
      if (!drive) {
        const creds = await readGlobalCreds();
        if (!creds || creds.server !== args.flags.server) {
          await cmdLogin(buildArgs(opts, ["login"]));
        }
      }
      // `--detach`: re-spawn ourselves in the background and return the
      // terminal. AINDRIVE_DETACHED marks the child so it serves foreground
      // (no recursion). First-time pairing needs the interactive/browser flow,
      // so require an existing pair before detaching.
      if (opts.detach && !process.env.AINDRIVE_DETACHED) {
        const paired = await readDriveConfig(dir);
        if (!paired) {
          throw new Error("run `aindrive` here once to pair this folder, then `aindrive -d` to background it");
        }
        const childArgv = [resolvedFolder];
        if (opts.server && opts.server !== DEFAULT_SERVER) childArgv.push("--server", opts.server);
        if (opts.open === false) childArgv.push("--no-open");
        const res = startDetached(dir, childArgv);
        if (res.already) {
          console.log(`\n  aindrive is already serving ${dir} in the background (pid ${res.pid})\n  → \`aindrive logs\` to follow · \`aindrive stop\` to stop\n`);
        } else {
          console.log(`\n  ✓ aindrive serving ${dir} in the background (pid ${res.pid})\n  → \`aindrive status\` · \`aindrive logs\` to follow · \`aindrive stop\` to stop\n`);
        }
        return;
      }
      await cmdServe({ ...args, dir });
    });

  // login subcommand — also pairs and serves the current folder
  program
    .command("login")
    .description("sign in and serve the current folder")
    .option("--server <url>", "server URL", DEFAULT_SERVER)
    .option("--no-open", "do not open the browser")
    .action(async (opts) => {
      const parentOpts = program.opts();
      const mergedOpts = { ...parentOpts, ...opts };
      const args = buildArgs(mergedOpts, ["login"]);
      await cmdLogin(args);
      const dir = resolve(".");
      if (existsSync(dir)) await cmdServe({ ...args, dir });
    });

  // status subcommand
  program
    .command("status")
    .description("show drive id, server URL, connection")
    .argument("[folder]", "folder to check (default: .)")
    .option("--server <url>", "server URL", DEFAULT_SERVER)
    .action(async (folder, opts) => {
      const parentOpts = program.opts();
      const mergedOpts = { ...parentOpts, ...opts };
      const positional = ["status"];
      if (folder) positional.push(folder);
      await cmdStatus(buildArgs(mergedOpts, positional));
    });

  // stop subcommand — stop the background agent for a folder
  program
    .command("stop")
    .description("stop the background agent serving a folder")
    .argument("[folder]", "folder (default: .)")
    .action(async (folder, opts) => {
      const mergedOpts = { ...program.opts(), ...opts };
      const positional = ["stop"];
      if (folder) positional.push(folder);
      await cmdStop(buildArgs(mergedOpts, positional));
    });

  // logs subcommand — follow the background agent's output (tail -f)
  program
    .command("logs")
    .description("follow the background agent's log output (Ctrl+C to stop)")
    .argument("[folder]", "folder (default: .)")
    .action(async (folder, opts) => {
      const mergedOpts = { ...program.opts(), ...opts };
      const positional = ["logs"];
      if (folder) positional.push(folder);
      await cmdLogs(buildArgs(mergedOpts, positional));
    });

  // rotate-token subcommand
  program
    .command("rotate-token")
    .description("rotate the per-drive agent token")
    .argument("[folder]", "folder with drive config (default: .)")
    .option("--server <url>", "server URL", DEFAULT_SERVER)
    .action(async (folder, opts) => {
      const parentOpts = program.opts();
      const mergedOpts = { ...parentOpts, ...opts };
      const positional = ["rotate-token"];
      if (folder) positional.push(folder);
      await cmdRotate(buildArgs(mergedOpts, positional));
    });

  // mcp subcommand — run an MCP server (stdio) exposing this owner's drives
  // and aindrive operations to AI assistants (Claude Code, Claude Desktop, …).
  program
    .command("mcp")
    .description("run a Model Context Protocol stdio server for aindrive")
    .option("--server <url>", "server URL", DEFAULT_SERVER)
    .action(async (opts) => {
      const parentOpts = program.opts();
      const mergedOpts = { ...parentOpts, ...opts };
      const args = buildArgs(mergedOpts, ["mcp"]);
      await cmdMcp(args);
    });

  await program.parseAsync(["node", "aindrive", ...argv]);
}

/** Build the args shape expected by command files: { flags, positional } */
function buildArgs(opts, positional) {
  return {
    positional,
    flags: {
      server: opts.server ?? DEFAULT_SERVER,
      name: opts.name,
      open: opts.open !== false,
    },
  };
}
