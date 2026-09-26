// A self-contained aindrive for E2E: its own server, owner, drive and CLI agent
// serving a temp folder (the same steps as scenarios/global-setup.mjs).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(WEB, "..");

export type Harness = { base: string; cookie: string; driveId: string; folder: string; server: ChildProcess; agent: ChildProcess; startAgent(): Promise<void>; stop(): void };

async function until(ok: () => Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await ok()) return; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  throw new Error(`timed out: ${what}`);
}

export async function startHarness(port: number, files: Record<string, string | Buffer>): Promise<Harness> {
  const base = `http://localhost:${port}`;
  const data = mkdtempSync(join(tmpdir(), "willow-e2e-data-"));
  const server = spawn("node", ["server.js"], {
    cwd: WEB,
    env: { ...process.env, PORT: String(port), AINDRIVE_DATA_DIR: data, AINDRIVE_DEV_BYPASS_OTP: "1", AINDRIVE_DEV_BYPASS_X402: "1", AINDRIVE_PUBLIC_URL: base, NODE_ENV: "development" },
    stdio: "ignore",
  });
  await until(async () => (await fetch(`${base}/api/readyz`)).status === 200, 120_000, "server");
  const signup = await fetch(`${base}/api/auth/signup`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.9.${port % 250}.9` }, body: JSON.stringify({ email: `w-${Date.now()}@example.com`, name: "Willow Owner", password: "willowpass1234" }) });
  const cookie = signup.headers.get("set-cookie")!.split(";")[0];
  const drive = await (await fetch(`${base}/api/drives`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "willow-e2e" }) })).json();
  const folder = mkdtempSync(join(tmpdir(), "willow-e2e-folder-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(folder, name), body);
  mkdirSync(join(folder, ".aindrive"), { recursive: true });
  writeFileSync(join(folder, ".aindrive", "config.json"), JSON.stringify({ ...drive, serverUrl: base, url: `${base}/d/${drive.driveId}`, pairedAt: Date.now() }));
  copyFileSync(join(WEB, "scenarios/fixtures/sample/start-agent.mjs"), join(folder, "start-agent.mjs"));
  const h: Harness = {
    base, cookie, driveId: drive.driveId, folder, server, agent: null as unknown as ChildProcess,
    async startAgent() {
      h.agent = spawn("node", ["start-agent.mjs"], { cwd: folder, env: { ...process.env, AINDRIVE_REPO_ROOT: REPO }, stdio: "ignore" });
      await until(async () => (await (await fetch(`${base}/api/healthz`)).json()).agentsConnected >= 1, 30_000, "agent");
    },
    stop() { h.agent?.kill(); server.kill(); },
  };
  await h.startAgent();
  return h;
}
