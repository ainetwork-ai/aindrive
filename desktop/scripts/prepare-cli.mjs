// Bundles the CLI agent (../cli) into desktop/cli/aindrive.mjs — the exact
// `aindrive` that npm users run, so the app and the CLI never drift apart.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(desktop, "..", "cli");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

if (!existsSync(join(cli, "node_modules"))) execFileSync(npm, ["ci"], { cwd: cli, stdio: "inherit" });
execFileSync(process.execPath, ["build.mjs"], { cwd: cli, stdio: "inherit" });
mkdirSync(join(desktop, "cli"), { recursive: true });
copyFileSync(join(cli, "dist", "aindrive.mjs"), join(desktop, "cli", "aindrive.mjs"));
console.log("✓ desktop/cli/aindrive.mjs");
