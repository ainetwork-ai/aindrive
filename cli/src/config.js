import { promises as fsp, chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const GLOBAL_DIR = join(homedir(), ".aindrive");
const GLOBAL_FILE = join(GLOBAL_DIR, "credentials.json");

export async function readGlobalCreds() {
  if (!existsSync(GLOBAL_FILE)) return null;
  try { return JSON.parse(await fsp.readFile(GLOBAL_FILE, "utf8")); }
  catch { return null; }
}

export async function writeGlobalCreds(creds) {
  if (!existsSync(GLOBAL_DIR)) mkdirSync(GLOBAL_DIR, { recursive: true, mode: 0o700 });
  await fsp.writeFile(GLOBAL_FILE, JSON.stringify(creds, null, 2));
  try { chmodSync(GLOBAL_FILE, 0o600); } catch {}
}

export async function readDriveConfig(dir) {
  const file = join(resolve(dir), ".aindrive", "config.json");
  if (!existsSync(file)) return null;
  try { return JSON.parse(await fsp.readFile(file, "utf8")); }
  catch { return null; }
}

export async function writeDriveConfig(dir, config) {
  const metaDir = join(resolve(dir), ".aindrive");
  if (!existsSync(metaDir)) mkdirSync(metaDir, { recursive: true, mode: 0o700 });
  const file = join(metaDir, "config.json");
  await fsp.writeFile(file, JSON.stringify(config, null, 2));
  try { chmodSync(file, 0o600); } catch {}
}
