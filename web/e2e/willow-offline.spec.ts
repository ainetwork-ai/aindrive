// Offline editing on Willow (spec §7): edit with the network off, reload offline
// (service worker + the Willow store in IndexedDB), reconnect, and a second
// browser receives the text through the server peer. Self-contained: boots its own
// server, owner, drive and CLI agent, like scenarios/global-setup.mjs.
import { test, expect, type Browser } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(WEB, "..");
const PORT = 3984;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let agent: ChildProcess;
let cookie = "";
let driveId = "";

async function until(ok: () => Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await ok()) return; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  throw new Error(`timed out: ${what}`);
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const data = mkdtempSync(join(tmpdir(), "willow-e2e-data-"));
  server = spawn("node", ["server.js"], {
    cwd: WEB,
    env: { ...process.env, PORT: String(PORT), AINDRIVE_DATA_DIR: data, AINDRIVE_DEV_BYPASS_OTP: "1", AINDRIVE_DEV_BYPASS_X402: "1", AINDRIVE_PUBLIC_URL: BASE, NODE_ENV: "development" },
    stdio: "ignore",
  });
  await until(async () => (await fetch(`${BASE}/api/readyz`)).status === 200, 120_000, "server");

  const signup = await fetch(`${BASE}/api/auth/signup`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.9.9.9" }, body: JSON.stringify({ email: `w-${Date.now()}@example.com`, name: "Willow Owner", password: "willowpass1234" }) });
  cookie = signup.headers.get("set-cookie")!.split(";")[0];
  const drive = await (await fetch(`${BASE}/api/drives`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "willow-e2e" }) })).json();
  driveId = drive.driveId;

  const folder = mkdtempSync(join(tmpdir(), "willow-e2e-folder-"));
  writeFileSync(join(folder, "a.md"), "# Notes\n\nstart\n");
  mkdirSync(join(folder, ".aindrive"), { recursive: true });
  writeFileSync(join(folder, ".aindrive", "config.json"), JSON.stringify({ ...drive, serverUrl: BASE, url: `${BASE}/d/${driveId}`, pairedAt: Date.now() }));
  copyFileSync(join(WEB, "scenarios/fixtures/sample/start-agent.mjs"), join(folder, "start-agent.mjs"));
  agent = spawn("node", ["start-agent.mjs"], { cwd: folder, env: { ...process.env, AINDRIVE_REPO_ROOT: REPO }, stdio: "ignore" });
  await until(async () => (await (await fetch(`${BASE}/api/healthz`)).json()).agentsConnected >= 1, 30_000, "agent");
});

test.afterAll(() => { agent?.kill(); server?.kill(); });

async function context(browser: Browser) {
  const [name, value] = cookie.split("=");
  return browser.newContext({ storageState: { cookies: [{ name, value, domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax", expires: Math.floor(Date.now() / 1000) + 86400 }], origins: [] } });
}

test("edit offline, reload offline, reconnect: the text stays and reaches a second browser", async ({ browser }) => {
  test.setTimeout(180_000);
  const url = `${BASE}/d/${driveId}?path=a.md`;
  const a = await context(browser);
  const pa = await a.newPage();
  await pa.goto(url);
  await expect(pa.locator(".ProseMirror")).toContainText("start", { timeout: 60_000 });
  // a second online load, now controlled by the service worker, caches the page
  await pa.reload();
  await expect(pa.locator(".ProseMirror")).toContainText("start", { timeout: 60_000 });

  await a.setOffline(true);
  await pa.locator(".ProseMirror").click();
  await pa.keyboard.press("End");
  await pa.keyboard.type(" offline-edit-1");
  await expect(pa.locator(".ProseMirror")).toContainText("offline-edit-1");
  await pa.waitForTimeout(1500); // the entries are signed and stored in IndexedDB
  await pa.reload();
  await expect(pa.locator(".ProseMirror")).toContainText("offline-edit-1", { timeout: 30_000 });

  await a.setOffline(false);
  const b = await context(browser);
  const pb = await b.newPage();
  await pb.goto(url);
  await expect(pb.locator(".ProseMirror")).toContainText("offline-edit-1", { timeout: 60_000 });
});
