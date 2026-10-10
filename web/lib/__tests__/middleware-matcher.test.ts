import { describe, expect, it } from "vitest";
import { config, GIT_PAGE_MATCHER, MIDDLEWARE_MATCHER } from "../../middleware";
import { GIT_PAGE_REWRITE_SOURCE } from "../git-urls";
import nextConfig from "../../next.config";
// Next's own path-to-regexp build (what compiles `source` patterns); untyped, so typed here.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { match as ptrMatch } from "next/dist/compiled/path-to-regexp";
const match = ptrMatch as (src: string) => (path: string) => false | { params: Record<string, string> };

// Next compiles the matcher with path-to-regexp; the lookahead part is plain
// regex, so anchoring it here checks which paths reach the middleware.
const reaches = (path: string) => new RegExp(`^${MIDDLEWARE_MATCHER}$`).test(path);

describe("middleware matcher", () => {
  it("is the exported pattern, plus the repo-page entry (same conditions as the next.config rewrite)", async () => {
    expect(config.matcher).toEqual([MIDDLEWARE_MATCHER, GIT_PAGE_MATCHER]);
    expect(GIT_PAGE_MATCHER.source).toBe(GIT_PAGE_REWRITE_SOURCE);
    const rewrites = await (nextConfig.rewrites as () => Promise<{ beforeFiles: { source: string; has?: unknown; missing?: unknown; destination: string }[] }>)();
    const rule = rewrites.beforeFiles.find((r) => r.destination.startsWith("/d/by-slug/"))!;
    expect(rule.source).toBe(GIT_PAGE_REWRITE_SOURCE);
    expect(rule.has).toEqual(GIT_PAGE_MATCHER.has);
    expect(rule.missing).toEqual(GIT_PAGE_MATCHER.missing);
  });

  it("keeps JSON endpoints out, so large bodies are not cut at 10 MB", () => {
    for (const p of ["/api/drives/x/fs/write", "/mcp", "/mcp/d/-nLGGiI3VXYR", "/a2a", "/a2a/d/abc"]) {
      expect(reaches(p), p).toBe(false);
    }
  });

  it("keeps friendly git smart-HTTP (/<slug>/git/…) out, like /api/drives/…/git", () => {
    for (const p of ["/comcom/git/repo/info/refs", "/comcom/git/repo/git-receive-pack", "/comcom/git", "/comcom/git/"]) {
      expect(reaches(p), p).toBe(false);
    }
  });

  it("the repo-page entry takes browser page URLs and never a smart-HTTP path", () => {
    const m = match(GIT_PAGE_MATCHER.source);
    for (const p of ["/comcom/git/repo", "/comcom/git/repo/blob/main/a.py", "/comcom/git/repo/tree/feat/x/sub", "/comcom/git/repo/commits/main", "/comcom/git/repo.git"]) {
      expect(!!m(p), p).toBe(true);
    }
    for (const p of ["/comcom/git/repo/info/refs", "/comcom/git/repo/git-upload-pack", "/comcom/git/repo/git-receive-pack", "/comcom/git/repo.git/info/refs", "/comcom/git", "/comcom/git/"]) {
      expect(!!m(p), p).toBe(false);
    }
    // a browser's Accept matches, a git client's never does
    const accept = new RegExp(GIT_PAGE_MATCHER.has[0].value);
    expect(accept.test("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")).toBe(true);
    expect(accept.test("*/*")).toBe(false);
    expect(accept.test("application/x-git-upload-pack-result")).toBe(false);
  });

  it("still covers pages (security headers, silent SSO)", () => {
    for (const p of ["/", "/login", "/d/abc", "/mcpanel", "/a2abc", "/docs/mcp", "/comcom", "/comcom/gitlab", "/d/abc/git-notes.md"]) {
      expect(reaches(p), p).toBe(true);
    }
  });
});
