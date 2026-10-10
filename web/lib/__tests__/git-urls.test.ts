// lib/git-urls.ts — GitHub's URL convention for a repo in a drive: parse ↔ build
// round-trips, git smart-HTTP paths never parse as pages, and lib/git-paths.ts
// maps a repo name to its working copy / bare remote.
import { describe, it, expect } from "vitest";
import { gitCrumbs, gitRepoUrl, gitUrl, isGitClientPath, parseGitPathname, parseGitUrlPath, repoRelative } from "../git-urls";
import { GIT_REPOS_DIR, bareOf, repoNameOf, workingCopyOf, workingCopyPath } from "../git-paths";

const site = { org: "comcom", repo: "clef-artwork-search" };
const opts = { defaultBranch: "main" };

describe("parseGitUrlPath", () => {
  it("reads every route shape, stripping .git and decoding each segment once", () => {
    expect(parseGitUrlPath(["clef-artwork-search"])).toEqual({ repo: "clef-artwork-search", view: "tree", ref: null, path: "" });
    expect(parseGitUrlPath(["clef-artwork-search.git"])).toEqual({ repo: "clef-artwork-search", view: "tree", ref: null, path: "" });
    expect(parseGitUrlPath(["r", "tree", "main"])).toEqual({ repo: "r", view: "tree", ref: "main", path: "" });
    expect(parseGitUrlPath(["r", "tree", "feature%2Fx", "src", "a%20b"])).toEqual({ repo: "r", view: "tree", ref: "feature/x", path: "src/a b" });
    expect(parseGitUrlPath(["r", "blob", "main", "art_search.py"])).toEqual({ repo: "r", view: "blob", ref: "main", path: "art_search.py" });
    expect(parseGitUrlPath(["r", "raw", "0123abc", "dir", "f.txt"])).toEqual({ repo: "r", view: "raw", ref: "0123abc", path: "dir/f.txt" });
    expect(parseGitUrlPath(["r", "commits"])).toEqual({ repo: "r", view: "commits", ref: null });
    expect(parseGitUrlPath(["r", "commits", "main"])).toEqual({ repo: "r", view: "commits", ref: "main" });
    expect(parseGitUrlPath(["r", "commit", "ABCDEF0123"])).toEqual({ repo: "r", view: "commit", sha: "abcdef0123" });
    expect(parseGitUrlPath(["r", "deployments"])).toEqual({ repo: "r", view: "deployments" });
  });

  it("answers null for anything else — notably every git smart-HTTP path", () => {
    for (const p of [[], ["r", "info", "refs"], ["r", "git-upload-pack"], ["r", "git-receive-pack"], ["r.git", "info", "refs"], ["r", "blob", "main"], ["r", "nope"], ["r", "commit", "zz"], ["r", "commit", "abc", "x"], ["r", "deployments", "x"], ["..", "tree", "main"], ["r", "tree", "main", ".."], ["%ZZ"], [".hidden"]]) {
      expect(parseGitUrlPath(p), p.join("/")).toBeNull();
    }
    expect(isGitClientPath(["r", "info", "refs"])).toBe(true);
    expect(isGitClientPath(["r", "tree", "main", "info", "refs"])).toBe(true);
    expect(isGitClientPath(["r", "git-upload-pack"])).toBe(true);
    expect(isGitClientPath(["r", "blob", "main", "x.py"])).toBe(false);
  });
});

describe("gitUrl", () => {
  it("spells the routes, encodes segments, and makes the default branch's root the bare repo URL", () => {
    expect(gitRepoUrl(site)).toBe("/comcom/git/clef-artwork-search");
    expect(gitUrl(site, { view: "tree", ref: null, path: "" }, opts)).toBe("/comcom/git/clef-artwork-search");
    expect(gitUrl(site, { view: "tree", ref: "main", path: "" }, opts)).toBe("/comcom/git/clef-artwork-search");
    expect(gitUrl(site, { view: "tree", ref: "dev", path: "" }, opts)).toBe("/comcom/git/clef-artwork-search/tree/dev");
    expect(gitUrl(site, { view: "tree", ref: "main", path: "src/a b" }, opts)).toBe("/comcom/git/clef-artwork-search/tree/main/src/a%20b");
    expect(gitUrl(site, { view: "blob", ref: "feature/x", path: "art_search.py" }, opts)).toBe("/comcom/git/clef-artwork-search/blob/feature%2Fx/art_search.py");
    expect(gitUrl(site, { view: "raw", ref: null, path: "f.txt" }, opts)).toBe("/comcom/git/clef-artwork-search/raw/main/f.txt");
    expect(gitUrl(site, { view: "commits", ref: null }, opts)).toBe("/comcom/git/clef-artwork-search/commits/main");
    expect(gitUrl(site, { view: "commit", sha: "abc123" })).toBe("/comcom/git/clef-artwork-search/commit/abc123");
    expect(gitUrl(site, { view: "deployments" })).toBe("/comcom/git/clef-artwork-search/deployments");
  });

  it("round-trips through parseGitPathname", () => {
    const targets = [
      { view: "tree", ref: "main", path: "src/a b" }, { view: "blob", ref: "feature/x", path: "p/q.py" }, { view: "raw", ref: "abc", path: "f" },
      { view: "commits", ref: "dev" }, { view: "commit", sha: "abc123" }, { view: "deployments" },
    ] as const;
    for (const t of targets) {
      const url = gitUrl(site, t, opts);
      expect(parseGitPathname(url)).toEqual({ org: "comcom", target: { repo: site.repo, ...t } });
    }
    expect(parseGitPathname("/comcom/git/clef-artwork-search")).toEqual({ org: "comcom", target: { repo: site.repo, view: "tree", ref: null, path: "" } });
    expect(parseGitPathname("/d/abc")).toBeNull();
    expect(parseGitPathname("/comcom/git/r/info/refs")).toBeNull();
  });

  it("builds the org / repo / path breadcrumb and repo-relative paths", () => {
    expect(gitCrumbs(site, "main", "src/lib", opts)).toEqual([
      { label: "clef-artwork-search", href: "/comcom/git/clef-artwork-search" },
      { label: "src", href: "/comcom/git/clef-artwork-search/tree/main/src" },
      { label: "lib", href: "/comcom/git/clef-artwork-search/tree/main/src/lib" },
    ]);
    expect(repoRelative("repositories/r", "repositories/r/a/b")).toBe("a/b");
    expect(repoRelative("repositories/r", "repositories/r")).toBe("");
    expect(repoRelative("repositories/r", "repositories/rx/a")).toBeNull();
  });
});

describe("git-paths", () => {
  it("maps a repo name to repositories/<name> (working copy) and repositories/<name>.git (bare)", () => {
    expect(GIT_REPOS_DIR).toBe("repositories");
    expect(workingCopyPath("clef")).toBe("repositories/clef");
    expect(workingCopyPath("clef.git")).toBe("repositories/clef");
    expect(bareOf("repositories/clef")).toBe("repositories/clef.git");
    expect(bareOf("repositories/clef.git")).toBe("repositories/clef.git");
    expect(workingCopyOf("repositories/clef.git")).toBe("repositories/clef");
    expect(workingCopyOf("proj")).toBe("proj");
    expect(repoNameOf("repositories/clef")).toBe("clef");
    expect(repoNameOf("repositories/clef.git")).toBe("clef");
    expect(repoNameOf("proj")).toBeNull();
    expect(repoNameOf("repositories/a/b")).toBeNull();
  });
});
