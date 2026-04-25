import { test, expect, BrowserContext, Page, Browser } from "@playwright/test";
import * as fs from "fs";

const BASE_URL = "http://localhost:3737";
const DRIVE_ID = "rr5NDM0UQI4J";
const EMAIL = "m5-1776999478@example.com";
const PASSWORD = "m5pass1234";
const README_PATH = "/mnt/newdata/git/aindrive/sample/README.md";

/** Login via the API and return the session cookie value */
async function getSessionCookie(page: Page): Promise<string> {
  const resp = await page.request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
    headers: { "content-type": "application/json" },
  });
  expect(resp.ok(), `Login failed: ${await resp.text()}`).toBe(true);
  // Extract cookie from response headers
  const setCookie = resp.headers()["set-cookie"] ?? "";
  const match = setCookie.match(/aindrive_session=([^;]+)/);
  if (!match) throw new Error(`No aindrive_session cookie in: ${setCookie}`);
  return match[1];
}

/** Create a logged-in browser context by injecting the session cookie */
async function createLoggedInContext(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  // Use a temp context just to get the cookie
  const tempContext = await browser.newContext();
  const tempPage = await tempContext.newPage();
  const cookie = await getSessionCookie(tempPage);
  await tempContext.close();

  // Create real context with the cookie pre-set
  const context = await browser.newContext({
    storageState: {
      cookies: [
        {
          name: "aindrive_session",
          value: cookie,
          domain: "localhost",
          path: "/",
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
          expires: Math.floor(Date.now() / 1000) + 2592000,
        },
      ],
      origins: [],
    },
  });
  const page = await context.newPage();
  return { context, page };
}

async function openReadme(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/d/${DRIVE_ID}`);
  // Wait for the file list table to appear
  await page.waitForSelector("table tbody tr", { timeout: 20000 });
  // Click the README.md row
  const row = page.locator("table tbody tr").filter({ hasText: "README.md" }).first();
  await row.click();
  // Wait for Monaco editor textarea to mount
  await page.waitForSelector(".monaco-editor textarea", { timeout: 30000 });
  // Wait for Y.js to sync: "connecting" text disappears from any header span
  await page.waitForFunction(
    () => {
      const spans = Array.from(document.querySelectorAll("aside header span"));
      return !spans.some((s) => s.textContent?.trim() === "connecting");
    },
    { timeout: 30000 }
  );
  // Extra settle time for Y.js doc to fully hydrate
  await page.waitForTimeout(1500);
}

async function getEditorValue(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as unknown as {
      monaco?: { editor?: { getModels?: () => Array<{ getValue?: () => string }> } };
    };
    const models = w.monaco?.editor?.getModels?.();
    if (models && models.length > 0) {
      return models[0].getValue?.() ?? "";
    }
    const ta = document.querySelector(".monaco-editor textarea") as HTMLTextAreaElement | null;
    return ta?.value ?? "";
  });
}

test.describe("concurrent collaborative editing", () => {
  test("two contexts see each other's edits and file is saved to disk", async ({ browser }) => {
    const { context: contextA, page: pageA } = await createLoggedInContext(browser);
    const { context: contextB, page: pageB } = await createLoggedInContext(browser);

    try {
      // Both open the README.md viewer
      await Promise.all([openReadme(pageA), openReadme(pageB)]);

      const tsA = Date.now();
      const textA = `AAAA-from-context-A-${tsA}`;
      await pageA.waitForTimeout(10);
      const tsB = Date.now();
      const textB = `BBBB-from-context-B-${tsB}`;

      // Context A: go to end and type
      await pageA.locator(".monaco-editor").first().click();
      await pageA.keyboard.press("Control+End");
      await pageA.keyboard.type(`\n${textA}`);

      // Context B: go to end and type
      await pageB.locator(".monaco-editor").first().click();
      await pageB.keyboard.press("Control+End");
      await pageB.keyboard.type(`\n${textB}`);

      // Wait for autosave debounce (5s) + buffer
      await pageA.waitForTimeout(7000);

      const valueA = await getEditorValue(pageA);
      const valueB = await getEditorValue(pageB);

      console.log(`--- Context A (last 300 chars) ---\n...${valueA.slice(-300)}`);
      console.log(`--- Context B (last 300 chars) ---\n...${valueB.slice(-300)}`);

      expect(valueA, "Context A editor should contain textA").toContain(textA);
      expect(valueA, "Context A editor should contain textB").toContain(textB);
      expect(valueB, "Context B editor should contain textA").toContain(textA);
      expect(valueB, "Context B editor should contain textB").toContain(textB);

      const diskContent = fs.readFileSync(README_PATH, "utf8");
      console.log(`--- Disk (last 300 chars) ---\n...${diskContent.slice(-300)}`);
      expect(diskContent, "Disk file should contain textA").toContain(textA);
      expect(diskContent, "Disk file should contain textB").toContain(textB);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
