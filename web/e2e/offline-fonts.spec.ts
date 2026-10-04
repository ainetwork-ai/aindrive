import { expect, test, type Page } from "@playwright/test";
import { systemFontCoverage } from "./system-font-coverage";

const korean = "한글 문서와 공유 파일을 어디서나 확인하세요";

// Inspect the fonts Chromium actually painted, not just computed font-family
// (which still names the web font after its download has failed).
async function paintedFonts(page: Page, selector: string) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    expect(nodeId, selector).toBeGreaterThan(0);
    return (await cdp.send("CSS.getPlatformFontsForNode", { nodeId })).fonts
      .filter((font) => font.glyphCount > 0);
  } finally {
    await cdp.detach();
  }
}

async function expectUnclippedText(page: Page) {
  const violations = await page.locator("main").evaluate((main) => {
    const errors: string[] = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) errors.push("horizontal page overflow");
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent?.trim()) continue;
      const parent = node.parentElement!;
      if (getComputedStyle(parent).visibility === "hidden") continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (!rect.width || !rect.height) continue;
        if (rect.left < -1 || rect.right > innerWidth + 1) errors.push(`outside viewport: ${node.textContent}`);
        // ScrollWidth alone misses text hidden by overflow/ellipsis/line-clamp.
        for (let ancestor: HTMLElement | null = parent; ancestor; ancestor = ancestor.parentElement) {
          const css = getComputedStyle(ancestor);
          const box = ancestor.getBoundingClientRect();
          if (/hidden|clip/.test(css.overflowX) && (rect.left < box.left - 1 || rect.right > box.right + 1)) {
            errors.push(`horizontally clipped: ${node.textContent}`);
          }
          if (/hidden|clip/.test(css.overflowY) && (rect.top < box.top - 1 || rect.bottom > box.bottom + 1)) {
            errors.push(`vertically clipped: ${node.textContent}`);
          }
        }
      }
    }
    return errors;
  });
  expect(violations).toEqual([]);
}

async function expectHeadingFont(page: Page, blocked: boolean) {
  const fonts = await paintedFonts(page, "main h1");
  expect(fonts.length).toBeGreaterThan(0);
  expect(fonts.every((font) => font.isCustomFont === !blocked)).toBe(true);
  if (!blocked) expect(fonts.every((font) => /^Inter/.test(font.postScriptName))).toBe(true);
}

for (const width of [320, 1280]) {
  for (const blocked of [false, true]) {
    test(`${width}px: ${blocked ? "blocked font fallback" : "bundled fonts"}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      const requestedFonts = new Set<string>();
      const failedFonts = new Set<string>();
      const remoteFonts = new Set<string>();
      const origin = new URL(testInfo.project.use.baseURL!).origin;
      // Installed browsers/fonts are prerequisites. No test-time downloads or
      // cached font success: each test gets a fresh context and routing disables cache.
      await page.route("**/*", async (route) => {
        const request = route.request();
        const isFont = request.resourceType() === "font";
        if (isFont) requestedFonts.add(request.url());
        if (new URL(request.url()).origin !== origin) {
          if (isFont || /fonts\.(googleapis|gstatic)\.com/.test(request.url())) remoteFonts.add(request.url());
          return route.abort("blockedbyclient");
        }
        if (blocked && isFont) return route.abort("failed");
        return route.continue();
      });
      page.on("requestfailed", (request) => {
        if (request.resourceType() === "font") failedFonts.add(request.url());
      });

      expect((await page.goto("/"))?.ok()).toBe(true);
      await expect(page.getByRole("heading", { name: "aindrive", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Create account" })).toBeVisible();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await expectHeadingFont(page, blocked);
      await expectUnclippedText(page);
      // Exercise the installation instructions when they are actually painted,
      // including long comments at 320px with both bundled and fallback fonts.
      await page.getByText("Or from a terminal", { exact: true }).click();
      await expect(page.locator("main pre")).toBeVisible();
      await expect(page.locator("main pre")).toHaveText(
        "npm i -g aindrive     # install once\ncd ~/Documents\naindrive              # this folder is now in aindrive",
      );
      await expectUnclippedText(page);

      // The current public pages use sans only and English copy. Add specimens
      // INSIDE the real landing layout to exercise its inherited CSS variables,
      // the otherwise unused display face, and system Hangul glyph fallback.
      // Do not replace the document or mock Next's generated CSS/font responses.
      await page.locator("main > div").evaluate((container, text) => {
        const section = document.createElement("section");
        section.id = "font-specimens";
        for (const [id, family, style] of [
          ["sans", "var(--font-sans)", "normal"],
          ["regular", "var(--font-display)", "normal"],
          ["italic", "var(--font-display)", "italic"],
        ]) {
          const paragraph = document.createElement("p");
          paragraph.style.cssText = `font-family:${family};font-style:${style};font-size:24px;line-height:1.5;margin-top:16px`;
          const latin = document.createElement("span");
          latin.id = `latin-${id}`;
          latin.textContent = "Shared files, everywhere.";
          const hangul = document.createElement("span");
          hangul.id = `korean-${id}`;
          hangul.lang = "ko";
          hangul.textContent = text;
          paragraph.append(latin, document.createElement("br"), hangul);
          section.append(paragraph);
        }
        container.append(section);
      }, korean);
      await page.locator("#font-specimens p").evaluateAll(async (paragraphs) => {
        // Force all three faces to settle even if a specimen starts below the fold.
        await Promise.allSettled(paragraphs.map((paragraph) => {
          const css = getComputedStyle(paragraph);
          return document.fonts.load(`${css.fontStyle} ${css.fontSize} ${css.fontFamily}`, "Shared files");
        }));
        await document.fonts.ready;
      });

      const faces = await page.evaluate(() => Array.from(document.fonts)
        .filter((face) => !face.family.includes("Fallback"))
        .map((face) => ({ status: face.status, style: face.style })));
      expect(faces).toHaveLength(3);
      expect(faces.filter((face) => face.style === "italic")).toHaveLength(1);
      expect(faces.every((face) => face.status === (blocked ? "error" : "loaded"))).toBe(true);
      expect(requestedFonts.size).toBe(3);
      expect(failedFonts.size).toBe(blocked ? 3 : 0);

      for (const [id, postScriptName] of [
        ["sans", /^Inter/], ["regular", /^InstrumentSerif-Regular$/], ["italic", /^InstrumentSerif-Italic$/],
      ] as const) {
        const latin = await paintedFonts(page, `#latin-${id}`);
        expect(latin.length).toBeGreaterThan(0);
        expect(latin.every((font) => font.isCustomFont === !blocked)).toBe(true);
        if (!blocked) expect(latin.some((font) => postScriptName.test(font.postScriptName))).toBe(true);
        await expect(page.locator(`#korean-${id}`)).toHaveText(korean);
        await expect(page.locator(`#korean-${id}`)).toBeVisible();
        const hangul = await paintedFonts(page, `#korean-${id}`);
        // Require actual Hangul coverage, not a missing-glyph box or a guessed
        // family name. Linux QA images may supply Noto, WenQuanYi, etc.
        const cjk = /Noto.*(?:CJK|KR|Korean)|Malgun|Apple.*Gothic|Nanum|Gulim|Batang|UnDotum|Droid Sans Fallback|Arial Unicode/i;
        const hangulText = korean.replace(/\s/g, "");
        const covered = new Set<number>();
        const supportingFonts = hangul.filter((font) => {
          if (font.isCustomFont) return false;
          if (process.platform !== "linux") return cjk.test(font.familyName);
          const codepoints = systemFontCoverage(font.familyName, hangulText);
          codepoints.forEach((codepoint) => covered.add(codepoint));
          return codepoints.length > 0;
        });
        if (process.platform === "linux") {
          expect([...covered].sort(),
            `Install a Hangul-capable system font in the offline browser image. Painted fonts: ${JSON.stringify(hangul)}`,
          ).toEqual([...new Set(Array.from(hangulText, (char) => char.codePointAt(0)!))].sort());
        }
        expect(supportingFonts
          .reduce((sum, font) => sum + font.glyphCount, 0)).toBeGreaterThan(15);
      }
      await expect(page.locator("#latin-italic")).toHaveCSS("font-style", "italic");
      await expect(page.locator("#latin-regular")).toHaveCSS("font-style", "normal");
      await expectUnclippedText(page);
      await testInfo.attach("landing-and-font-specimens", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

      expect((await page.goto("/login"))?.ok()).toBe(true);
      await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
      await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await expectHeadingFont(page, blocked);
      await expectUnclippedText(page);
      await testInfo.attach("login", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      expect([...remoteFonts]).toEqual([]);
    });
  }
}
