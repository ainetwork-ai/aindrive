import { resolve } from "node:path";
import { apiFetch } from "../api.js";
import { readDriveConfig, readGlobalCreds, writeDriveConfig } from "../config.js";

export async function cmdRotate(args) {
  const dir = resolve(args.positional[1] || ".");
  const creds = await readGlobalCreds();
  if (!creds) throw new Error("run `aindrive login` first");
  const drive = await readDriveConfig(dir);
  if (!drive) throw new Error(`no drive linked at ${dir}`);
  const { agentToken, driveSecret } = await apiFetch(creds.server, `/api/drives/${drive.driveId}/rotate`, {
    method: "POST",
    token: creds.accessToken,
  });
  await writeDriveConfig(dir, { ...drive, agentToken, driveSecret, rotatedAt: Date.now() });
  console.log("  ✓ agent token rotated");
}
