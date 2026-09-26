// shared/a2ui/renderer.js draws AINUI FileView with a download affordance
// (docs/AINUI.md §3) for every kind of file, not just image/video/audio.
// No DOM library in this repo, so a tiny fake `document` stands in: the
// renderer only creates elements, sets properties and appends children.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ainuiFile } from "../../shared/a2ui/ainui";
import { aindriveAssetUrl, createA2uiRenderer } from "../../shared/a2ui/renderer.js";

class FakeEl {
  tagName: string;
  children: FakeEl[] = [];
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  className = "";
  textContent = "";
  [prop: string]: any;
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  get classList() { return { add: (c: string) => { this.className = `${this.className} ${c}`.trim(); } }; }
  appendChild(c: FakeEl) { this.children.push(c); return c; }
  append(...cs: FakeEl[]) { cs.forEach((c) => this.appendChild(c)); }
  replaceChildren(...cs: FakeEl[]) { this.children = cs; }
  setAttribute(k: string, v: unknown) { this.attributes[k] = String(v); }
  addEventListener() {}
  focus() {}
}

const all = (el: FakeEl): FakeEl[] => [el, ...el.children.flatMap(all)];
const byClass = (el: FakeEl, cls: string) => all(el).filter((e) => e.className.split(/\s+/).includes(cls));

const realDocument = (globalThis as any).document;
beforeAll(() => { (globalThis as any).document = { createElement: (t: string) => new FakeEl(t) }; });
afterAll(() => { (globalThis as any).document = realDocument; });

function draw(msgs: unknown[], opts: Record<string, unknown> = {}) {
  const host = new FakeEl("div");
  createA2uiRenderer(host as unknown as HTMLElement, opts).replace(msgs as any);
  const view = byClass(host, "a2ui-fileview");
  expect(view).toHaveLength(1);
  return view[0];
}
const file = (path: string, mime: string, size = 1234) => ainuiFile({ driveId: "d1", path, mime, size, mtime: 77 });

describe("aindriveAssetUrl", () => {
  const asset = { drive_id: "d 1", path: "docs/a b.pdf", variant: "original", mime: "application/pdf", v: 5 };
  it("thumb → fs/thumbnail, original → fs/stream (cache key kept)", () => {
    expect(aindriveAssetUrl({ ...asset, variant: "thumb" }, "https://x")).toBe("https://x/api/drives/d%201/fs/thumbnail?path=docs%2Fa%20b.pdf&v=5");
    expect(aindriveAssetUrl(asset)).toBe("/api/drives/d%201/fs/stream?path=docs%2Fa%20b.pdf&v=5");
  });
  it("{ download: true } → fs/download (attachment), whatever the variant", () => {
    expect(aindriveAssetUrl({ ...asset, variant: "thumb" }, "https://x", { download: true })).toBe("https://x/api/drives/d%201/fs/download?path=docs%2Fa%20b.pdf");
  });
});

describe("renderer FileView download affordance", () => {
  it("a PDF (no inline viewer) gets a kind icon AND a download link to fs/download", () => {
    const view = draw(file("docs/report.pdf", "application/pdf"));
    expect(byClass(view, "a2ui-fileview-icon")).toHaveLength(1);
    const [a] = byClass(view, "a2ui-fileview-download");
    expect(a).toMatchObject({
      tagName: "A", href: "/api/drives/d1/fs/download?path=docs%2Freport.pdf",
      download: "report.pdf", target: "_blank", rel: "noopener noreferrer",
    });
    expect(a.attributes["aria-label"]).toBe("Download report.pdf");
    // It sits in the info row next to the name and size.
    expect(byClass(view, "a2ui-fileview-info")[0].children).toContain(a);
  });

  it("text, archives and media all get one too; the image still previews through fs/stream", () => {
    for (const [p, m] of [["a.md", "text/markdown"], ["b.zip", "application/zip"], ["c.mp4", "video/mp4"]]) {
      expect(byClass(draw(file(p, m)), "a2ui-fileview-download")[0].href).toBe(`/api/drives/d1/fs/download?path=${p}`);
    }
    const img = draw(file("p.jpg", "image/jpeg"), { assetBase: "https://drive.test" });
    expect(all(img).find((e) => e.tagName === "IMG")!.src).toBe("https://drive.test/api/drives/d1/fs/stream?path=p.jpg&v=77");
    expect(byClass(img, "a2ui-fileview-download")[0].href).toBe("https://drive.test/api/drives/d1/fs/download?path=p.jpg");
  });

  it("a host resolver is asked for the original bytes with { download: true }", () => {
    const calls: unknown[][] = [];
    const resolveAsset = (a: { path: string }, o?: { download?: boolean }) => {
      calls.push([a, o]);
      return o?.download ? `/api/aindrive/raw?path=${encodeURIComponent(a.path)}&dl=1` : "";
    };
    const view = draw(file("x/notes.txt", "text/plain"), { resolveAsset });
    expect(byClass(view, "a2ui-fileview-download")[0].href).toBe("/api/aindrive/raw?path=x%2Fnotes.txt&dl=1");
    expect(calls).toContainEqual([expect.objectContaining({ path: "x/notes.txt", variant: "original" }), { download: true }]);
  });

  it("data: text downloads are allowed; unsafe or missing URLs draw no link", () => {
    const withUrl = (u: string) => draw(file("t.txt", "text/plain"), { resolveAsset: (_a: unknown, o?: { download?: boolean }) => (o?.download ? u : "") });
    expect(byClass(withUrl("data:text/plain;charset=utf-8,hi"), "a2ui-fileview-download")[0].href).toBe("data:text/plain;charset=utf-8,hi");
    for (const bad of ["javascript:alert(1)", "data:text/html,<b>x</b>", "//evil.test/x", "http://plain.test/x", ""]) {
      expect(byClass(withUrl(bad), "a2ui-fileview-download"), bad).toHaveLength(0);
    }
  });
});
