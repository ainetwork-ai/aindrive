import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { Command } from "commander";
import { cmdLogin } from "./commands/login.js";
import { cmdServe } from "./commands/serve.js";
import { cmdRotate } from "./commands/rotate.js";
import { cmdStatus } from "./commands/status.js";
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
    .option("--no-open", "do not open the browser");

  // Default command: serve a folder (auto-login on first use)
  program
    .argument("[folder]", "folder to connect (default: .)")
    .action(async (folder, opts) => {
      const resolvedFolder = folder || ".";
      const dir = resolve(resolvedFolder);
      if (!existsSync(dir)) throw new Error(`folder does not exist: ${dir}`);
      const args = buildArgs(opts, []);
      const drive = await readDriveConfig(dir);
      if (!drive && !(await readGlobalCreds())) {
        await cmdLogin(buildArgs(opts, ["login"]));
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
