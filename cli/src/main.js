import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { cmdLogin } from "./commands/login.js";
import { cmdServe } from "./commands/serve.js";
import { cmdRotate } from "./commands/rotate.js";
import { cmdStatus } from "./commands/status.js";

const HELP = `aindrive — connect a local folder to your aindrive server

Usage:
  aindrive [folder]              Connect the folder (default: .) to the server
  aindrive login                 Authenticate this machine
  aindrive status                Show drive id, server URL, connection
  aindrive rotate-token          Rotate the per-drive agent token

Flags:
  --server <url>                 Server URL (default: env AINDRIVE_SERVER or http://localhost:3737)
  --name <name>                  Name for this drive on first pairing
  --no-open                      Do not open the browser
`;

export async function runCli(argv) {
  const args = parseArgs(argv);
  if (args.flags.help) return console.log(HELP);
  const cmd = args.positional[0];
  if (cmd === "login") return cmdLogin(args);
  if (cmd === "status") return cmdStatus(args);
  if (cmd === "rotate-token") return cmdRotate(args);
  const folder = cmd && cmd !== "serve" ? cmd : ".";
  const dir = resolve(folder);
  if (!existsSync(dir)) throw new Error(`folder does not exist: ${dir}`);
  return cmdServe({ ...args, dir });
}

function parseArgs(argv) {
  const positional = [];
  const flags = { server: process.env.AINDRIVE_SERVER || "http://localhost:3737", open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--server") flags.server = argv[++i];
    else if (a === "--name") flags.name = argv[++i];
    else if (a === "--no-open") flags.open = false;
    else if (a.startsWith("--")) flags[a.slice(2)] = argv[++i];
    else positional.push(a);
  }
  return { positional, flags };
}
