// P2P media, direct path (media spec M5): chunks come straight from the device
// (the CLI agent) to the page over WebRTC, verified; when the direct channel goes
// away, the rest comes from the server. Real server, real agent, real Chromium.
import { test, expect } from "@playwright/test";
import { randomBytes, createHash } from "node:crypto";
import { startHarness, type Harness } from "./willow-harness";

// Chrome hides local IPs behind mDNS names; the agent's WebRTC stack needs the real ones on a LAN.
test.use({ launchOptions: { args: ["--disable-features=WebRtcHideLocalIpsWithMdns"] } });

const VIDEO = randomBytes(3 * 1048576 + 54321);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
let h: Harness;

test.beforeAll(async () => { test.setTimeout(180_000); h = await startHarness(3986, { "v.mp4": VIDEO }); });
test.afterAll(() => h?.stop());

test("chunks come from the device over WebRTC; without the channel, from the server", async ({ browser }) => {
  test.setTimeout(150_000);
  const [name, value] = h.cookie.split("=");
  const ctx = await browser.newContext({ storageState: { cookies: [{ name, value, domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax", expires: Math.floor(Date.now() / 1000) + 3600 }], origins: [] } });
  const page = await ctx.newPage();
  await page.goto(`${h.base}/d/${h.driveId}`);
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller || (location.reload(), false), undefined, { timeout: 60_000, polling: 2000 }).catch(() => {});
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller && !!(window as unknown as { __aindriveP2P?: unknown }).__aindriveP2P, undefined, { timeout: 60_000 });

  const url = `/api/drives/${h.driveId}/fs/stream?path=v.mp4`;
  const all = await page.evaluate(async (u) => {
    const r = await fetch(u, { headers: { range: "bytes=0-" } });
    const b = await r.arrayBuffer();
    const d = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", b)), (x) => x.toString(16).padStart(2, "0")).join("");
    const s = (window as unknown as { __aindriveP2P: { p2pBytes: number; serverBytes: number } }).__aindriveP2P;
    return { status: r.status, len: b.byteLength, digest: d, p2p: s.p2pBytes, server: s.serverBytes };
  }, url);
  expect(all.status).toBe(206);
  expect(all.len).toBe(VIDEO.length);
  expect(all.digest).toBe(sha(VIDEO));
  expect(all.p2p).toBe(VIDEO.length); // every byte straight from the device
  expect(all.server).toBe(0);

  // without the direct path (switched off), the same bytes come from the server
  const mid = await page.evaluate(async (u) => {
    const s = (window as unknown as { __aindriveP2P: { p2pBytes: number; serverBytes: number; disabled: boolean; closeAll(): void } }).__aindriveP2P;
    s.closeAll();
    s.disabled = true;
    await new Promise((r) => setTimeout(r, 300));
    const before = s.p2pBytes;
    const r = await fetch(u, { headers: { range: "bytes=1000000-2200000" } });
    const b = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, len: b.length, first: b[0], p2pDelta: s.p2pBytes - before };
  }, url);
  expect(mid.status).toBe(206);
  expect(mid.len).toBe(1_200_001);
  expect(mid.first).toBe(VIDEO[1_000_000]);
  expect(mid.p2pDelta).toBe(0); // the worker went to the server itself
});
