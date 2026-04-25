import { request } from "undici";
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { readDriveConfig, readGlobalCreds, writeDriveConfig } from "../config.js";
import { runAgent } from "../agent.js";

export async function cmdServe(args) {
  const dir = args.dir;
  let drive = await readDriveConfig(dir);
  let serverUrl = args.flags.server;

  if (!drive) {
    const creds = await readGlobalCreds();
    if (!creds) throw new Error("run `aindrive login` first");
    serverUrl = creds.server;
    const name = args.flags.name || basename(dir);
    console.log(`  pairing new drive "${name}" with ${serverUrl}…`);
    const res = await apiCall(serverUrl, "POST", "/api/drives", { name }, creds.sessionCookie);
    drive = {
      driveId: res.driveId,
      agentToken: res.agentToken,
      driveSecret: res.driveSecret,
      serverUrl: res.serverUrl || serverUrl,
      url: res.url,
      pairedAt: Date.now(),
    };
    await writeDriveConfig(dir, drive);
    console.log(`  ✓ paired  ${res.url}`);
  } else if (!serverUrl || serverUrl === "http://localhost:3737") {
    serverUrl = drive.serverUrl || serverUrl;
  }

  const url = drive.url || `${serverUrl}/d/${drive.driveId}`;
  console.log(`\n  aindrive serving ${dir}`);
  console.log(`  → ${url}\n`);

  if (args.flags.open !== false) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    spawn(opener, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  }

  await runAgent({ root: dir, drive, server: drive.serverUrl || serverUrl });
}

async function apiCall(server, method, path, body, sessionCookie) {
  const { statusCode, body: respBody } = await request(new URL(path, server).toString(), {
    method,
    headers: {
      "content-type": "application/json",
      cookie: `aindrive_session=${sessionCookie}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await respBody.text();
  if (statusCode >= 400) {
    let msg = text;
    try { msg = JSON.parse(text).error || text; } catch {}
    throw new Error(`${method} ${path} → ${statusCode}: ${msg}`);
  }
  return text ? JSON.parse(text) : null;
}
