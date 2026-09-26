// P2P media, step 1: the device's uplink carries each chunk once. Played once,
// then the agent (the device) is stopped: the video still plays from the server's
// verified cache, byte for byte, including a Range in the middle.
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { startHarness, type Harness } from "./willow-harness";

const VIDEO = randomBytes(3 * 1048576 + 12345);
let h: Harness;

test.beforeAll(async () => { test.setTimeout(180_000); h = await startHarness(3985, { "v.mp4": VIDEO }); });
test.afterAll(() => h?.stop());

const get = async (range?: string) => {
  const r = await fetch(`${h.base}/api/drives/${h.driveId}/fs/stream?path=v.mp4`, { headers: { cookie: h.cookie, ...(range ? { range } : {}) } });
  return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
};

test("plays once from the device, then from the cache with the device off", async () => {
  test.setTimeout(120_000);
  const first = await get();
  expect(first.status).toBe(200);
  expect(first.body.equals(VIDEO)).toBe(true);

  h.agent.kill();
  await expect.poll(async () => (await (await fetch(`${h.base}/api/healthz`)).json()).agentsConnected, { timeout: 30_000 }).toBe(0);

  const again = await get();
  expect(again.status).toBe(200);
  expect(again.body.equals(VIDEO)).toBe(true);

  const mid = await get("bytes=1048000-2100000");
  expect(mid.status).toBe(206);
  expect(mid.body.equals(VIDEO.subarray(1048000, 2100001))).toBe(true);
});
