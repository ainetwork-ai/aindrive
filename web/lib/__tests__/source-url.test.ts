// Defect A (docs/06 §20.1): FileRef.sourceUrl is `/d/<driveId>/<path>` but the
// drive page is `/d/<driveId>?path=` — every "open original" 404'd. The
// catch-all route app/d/[driveId]/[...path] redirects the path form to the page.
import { describe, it, expect } from "vitest";
import { sourcePathRedirect, sourceUrlFor } from "../source-url";
import { GET, HEAD } from "../../app/d/[driveId]/[...path]/route";

const HANGUL_NFC = "전시 안내.md";
const HANGUL_NFD = HANGUL_NFC.normalize("NFD");
const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
const target = (loc: string) => new URL(loc, "https://drive.test");

describe("sourceUrlFor", () => {
  it("mints the contract path form, one encoded segment per name", () => {
    expect(sourceUrlFor("https://drive.test", "d1", "/")).toBe("https://drive.test/d/d1/");
    expect(sourceUrlFor("https://drive.test/", "d1", "/docs")).toBe("https://drive.test/d/d1/docs");
    expect(sourceUrlFor("https://drive.test", "d1", `/people/bob/files/${HANGUL_NFC}`))
      .toBe(`https://drive.test/d/d1/people/bob/files/${enc(HANGUL_NFC)}`);
    expect(sourceUrlFor("https://drive.test", "d1", "/a%b/c#d?e")).toBe("https://drive.test/d/d1/a%25b/c%23d%3Fe");
  });

  it("a top-level name owned by a static page (/manage) gets the page's ?path= form", () => {
    const u = new URL(sourceUrlFor("https://drive.test", "d1", "/manage/notes.md"));
    expect(u.pathname).toBe("/d/d1");
    expect(u.searchParams.get("path")).toBe("manage/notes.md");
    // Deeper "manage" segments do not collide.
    expect(sourceUrlFor("https://drive.test", "d1", "/docs/manage")).toBe("https://drive.test/d/d1/docs/manage");
  });

  it("every minted URL resolves: the redirect lands on the same path it was minted for", () => {
    for (const p of ["/docs", `/${HANGUL_NFC}`, "/a b/c+d.txt", "/100%/x"]) {
      const u = new URL(sourceUrlFor("https://drive.test", "d1", p));
      const r = sourcePathRedirect("d1", u.pathname.split("/").slice(3));
      expect(r.ok).toBe(true);
      if (r.ok) expect(target(r.location).searchParams.get("path")).toBe(p.slice(1));
    }
  });
});

describe("sourcePathRedirect", () => {
  it("decodes Hangul once and NFC-normalizes an NFD (macOS) spelling", () => {
    for (const name of [HANGUL_NFC, HANGUL_NFD]) {
      const r = sourcePathRedirect("d1", ["people", "bob", encodeURIComponent(name)]);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const t = target(r.location);
      expect(t.pathname).toBe("/d/d1");
      expect(t.searchParams.get("path")).toBe(`people/bob/${HANGUL_NFC}`);
    }
  });

  it("keeps spaces (%20) and a literal '+' as written", () => {
    const r = sourcePathRedirect("d1", ["my%20docs", "a+b.txt"]);
    expect(r.ok && target(r.location).searchParams.get("path")).toBe("my docs/a+b.txt");
  });

  it("does not decode twice (%2520 is a literal %20 in the name)", () => {
    const r = sourcePathRedirect("d1", ["x%2520y"]);
    expect(r.ok && target(r.location).searchParams.get("path")).toBe("x%20y");
  });

  it("refuses traversal, NUL, encoded slashes and malformed escapes", () => {
    for (const segs of [["..", "secret"], ["docs", "%2e%2e", "x"], ["%2E%2E"], ["a%2F..%2Fb"], ["a%2fb"], ["a%5Cb"], ["a%00b"], ["%E0%A4%A"], ["%"]]) {
      const r = sourcePathRedirect("d1", segs);
      expect(r, segs.join("/")).toMatchObject({ ok: false, status: 400 });
    }
  });

  it("drops '.' and empty segments; nothing left means the drive root", () => {
    expect(sourcePathRedirect("d1", [".", ""])).toEqual({ ok: true, location: "/d/d1" });
    const r = sourcePathRedirect("d1", ["a", ".", "b"]);
    expect(r.ok && target(r.location).searchParams.get("path")).toBe("a/b");
  });

  it("encodes the drive id into the target", () => {
    const r = sourcePathRedirect("a?b", ["x"]);
    expect(r.ok && target(r.location).pathname).toBe("/d/a%3Fb");
  });
});

describe("GET /d/[driveId]/[...path]", () => {
  const get = (path: string) => GET(new Request(`http://127.0.0.1:3737${path}`));

  it("307s the stored sourceUrl form to the drive page, relative Location, no caching", async () => {
    const res = await get(`/d/9Rt3ktNDN-3k/people/bob/files/${enc("작품 소개.txt")}`);
    expect(res.status).toBe(307);
    const loc = res.headers.get("location")!;
    expect(loc.startsWith("/d/9Rt3ktNDN-3k?")).toBe(true);
    expect(target(loc).searchParams.get("path")).toBe("people/bob/files/작품 소개.txt");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("an NFD-encoded link lands on the NFC path", async () => {
    const res = await get(`/d/d1/${encodeURIComponent(HANGUL_NFD)}`);
    expect(target(res.headers.get("location")!).searchParams.get("path")).toBe(HANGUL_NFC);
  });

  it("400s traversal and encoded slashes, and never redirects them", async () => {
    for (const p of ["/d/d1/%2e%2e%2f%2e%2e%2fetc", "/d/d1/a%2F..%2F..%2Fb", "/d/d1/a%00", "/d/d1/%zz"]) {
      const res = await get(p);
      expect(res.status, p).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("HEAD answers the same", async () => {
    const res = await HEAD(new Request("http://127.0.0.1:3737/d/d1/docs"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/d/d1?path=docs");
  });
});
