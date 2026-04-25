import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

function dataDir(): string {
  const dir = process.env.AINDRIVE_DATA_DIR || join(homedir(), ".aindrive");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function loadOrCreateSecret(): string {
  if (process.env.AINDRIVE_SESSION_SECRET) return process.env.AINDRIVE_SESSION_SECRET;
  const file = join(dataDir(), "session-secret");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const secret = randomBytes(32).toString("hex");
  writeFileSync(file, secret);
  try { chmodSync(file, 0o600); } catch {}
  return secret;
}

export const env = {
  get sessionSecret() { return loadOrCreateSecret(); },
  get publicUrl() {
    return process.env.AINDRIVE_PUBLIC_URL
      || `http://localhost:${process.env.PORT || 3737}`;
  },
};
