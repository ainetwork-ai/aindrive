import { resolve } from "node:path";
import { apiFetch } from "../api.js";
import { readDriveConfig, readGlobalCreds, writeDriveConfig } from "../config.js";

export async function cmdRotate(args) {
  const dir = resolve(args.positional[1] || ".");
  const creds = await readGlobalCreds();
  // `login` stores the session as `sessionCookie`; `accessToken` is the field
  // name this command used to read (never written) — accepted for old files.
  const session = creds?.sessionCookie || creds?.accessToken;
  if (!session) throw new Error("run `aindrive login` first");
  const drive = await readDriveConfig(dir);
  if (!drive) throw new Error(`no drive linked at ${dir}`);
  // The rotate route authenticates with the session COOKIE (web getUser()).
  const { agentToken, driveSecret } = await apiFetch(drive.serverUrl || creds.server, `/api/drives/${drive.driveId}/rotate`, {
    method: "POST",
    headers: { cookie: `aindrive_session=${session}` },
  });
  const { previousCredentials: _stale, ...rest } = drive;
  await writeDriveConfig(dir, { ...rest, agentToken, driveSecret, rotatedAt: Date.now() });
  console.log("  ✓ agent token rotated");
  console.log("  restart the agent for this folder (`aindrive stop` then `aindrive`) so it uses the new token");
}
