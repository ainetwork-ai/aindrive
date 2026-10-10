import { describe, expect, it } from "vitest";
import { config, MIDDLEWARE_MATCHER } from "../../middleware";

// Next compiles the matcher with path-to-regexp; the lookahead part is plain
// regex, so anchoring it here checks which paths reach the middleware.
const reaches = (path: string) => new RegExp(`^${MIDDLEWARE_MATCHER}$`).test(path);

describe("middleware matcher", () => {
  it("is the exported pattern", () => {
    expect(config.matcher).toEqual([MIDDLEWARE_MATCHER]);
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

  it("still covers pages (security headers, silent SSO)", () => {
    for (const p of ["/", "/login", "/d/abc", "/mcpanel", "/a2abc", "/docs/mcp", "/comcom", "/comcom/gitlab", "/d/abc/git-notes.md"]) {
      expect(reaches(p), p).toBe(true);
    }
  });
});
