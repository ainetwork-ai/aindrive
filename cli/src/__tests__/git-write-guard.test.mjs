import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { findGitWorkTree, describeGitWrite } from "../git-write-guard.js";

function tmp() { return mkdtempSync(path.join(tmpdir(), "aindrive-gwg-")); }

describe("git-write-guard", () => {
  it("finds the nearest .git ancestor, bounded by the drive root", () => {
    const root = tmp();
    try {
      mkdirSync(path.join(root, "repo", "sub"), { recursive: true });
      mkdirSync(path.join(root, "repo", ".git"));
      expect(findGitWorkTree(root, path.join(root, "repo", "sub", "a.py"))).toBe(path.join(root, "repo"));
      expect(findGitWorkTree(root, path.join(root, "plain.txt"))).toBe(null);
      // a .git ABOVE the drive root is not consulted
      const inner = path.join(root, "repo", "sub");
      expect(findGitWorkTree(inner, path.join(inner, "x.txt"))).toBe(null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reports whether the bytes differ from HEAD (tracked, untracked, outside a repo)", async () => {
    const root = tmp();
    try {
      const repo = path.join(root, "repo");
      mkdirSync(repo);
      const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
      const git = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe", env });
      git("init", "-q");
      writeFileSync(path.join(repo, "art_search.py"), "print(2)\n");
      git("add", "."); git("commit", "-q", "-m", "v2");
      const abs = path.join(repo, "art_search.py");
      // the stale text the editor tried to write back
      expect(await describeGitWrite(root, abs, Buffer.from("print(1)\n"))).toEqual({ workTree: repo, rel: "art_search.py", tracked: true, differsFromHead: true });
      expect(await describeGitWrite(root, abs, Buffer.from("print(2)\n"))).toEqual({ workTree: repo, rel: "art_search.py", tracked: true, differsFromHead: false });
      expect(await describeGitWrite(root, path.join(repo, "new.txt"), Buffer.from("x"))).toMatchObject({ tracked: false, differsFromHead: true });
      expect(await describeGitWrite(root, path.join(root, "loose.txt"), Buffer.from("x"))).toBe(null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
