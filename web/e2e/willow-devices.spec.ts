// Plan 4: the devices page lists this browser; removing it makes its next edit refused,
// and the editor says so. Real server, real agent, real Chromium.
import { test, expect } from "@playwright/test";
import { startHarness, type Harness } from "./willow-harness";

let h: Harness;
test.beforeAll(async () => { test.setTimeout(180_000); h = await startHarness(3987, { "a.md": "# Notes\n\nstart\n" }); });
test.afterAll(() => h?.stop());

test("list this browser, remove it, and its next edit is refused", async ({ browser }) => {
  test.setTimeout(150_000);
  const [name, value] = h.cookie.split("=");
  const ctx = await browser.newContext({ storageState: { cookies: [{ name, value, domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax", expires: Math.floor(Date.now() / 1000) + 3600 }], origins: [] } });
  const page = await ctx.newPage();
  await page.goto(`${h.base}/d/${h.driveId}?path=a.md`);
  await expect(page.locator(".ProseMirror")).toContainText("start", { timeout: 60_000 });
  await page.locator(".ProseMirror").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" first");
  await page.waitForTimeout(2000); // the certificate and the edit sync to the server

  await page.goto(`${h.base}/account/devices`);
  const mine = page.getByTestId("devices").locator("li", { hasText: "this browser" });
  await expect(mine).toContainText("vouched by aindrive", { timeout: 30_000 });
  page.on("dialog", (d) => d.accept());
  await mine.getByRole("button", { name: "Remove" }).click();
  await expect(mine).toContainText("removed", { timeout: 15_000 });

  await page.goto(`${h.base}/d/${h.driveId}?path=a.md`);
  await expect(page.locator(".ProseMirror")).toContainText("first", { timeout: 60_000 });
  await page.locator(".ProseMirror").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" after-revoke");
  await expect(page.getByTestId("willow-refused")).toContainText("revoked", { timeout: 30_000 });
});
