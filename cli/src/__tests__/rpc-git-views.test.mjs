// handleRpc read-only views behind the GitHub-like repo pages
// (git-refs / git-ls-tree / git-show / git-log / git-commit-detail) against the
// real `git` binary on a tmp drive root. All read the object store, so a ref
// other than the checked-out branch answers the committed content, not the
// working tree.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { handleRpc } from "../rpc.js";

process.env.AINDRIVE_TRACE = "off";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "Ann", GIT_AUTHOR_EMAIL: "ann@x.test", GIT_COMMITTER_NAME: "Ann", GIT_COMMITTER_EMAIL: "ann@x.test", GIT_AUTHOR_DATE: "2026-10-01T10:00:00+09:00", GIT_COMMITTER_DATE: "2026-10-01T10:00:00+09:00" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: ENV }).toString().trim();

let tmp, root, repo, first, second;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "rpc-git-views-"));
  root = path.join(tmp, "drive"); mkdirSync(root);
  repo = path.join(root, "proj");
  git(root, "init", "-q", "-b", "main", "proj");
  mkdirSync(path.join(repo, "lib"));
  writeFileSync(path.join(repo, "main.py"), "print('v1')\n");
  writeFileSync(path.join(repo, "lib", "util.py"), "x = 1\n");
  writeFileSync(path.join(repo, "ainize.json"), '{"entry":"main.py"}\n');
  git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "first\n\nbody line");
  first = git(repo, "rev-parse", "HEAD");
  writeFileSync(path.join(repo, "main.py"), "print('v2')\nprint('more')\n");
  git(repo, "commit", "-q", "-am", "second: edit main");
  second = git(repo, "rev-parse", "HEAD");
  git(repo, "branch", "feature", first);
  // uncommitted working-tree change — must NOT show through the ref views
  writeFileSync(path.join(repo, "main.py"), "print('dirty')\n");
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("git-refs", () => {
  it("names the checked-out branch, its sha and every branch", async () => {
    const r = await handleRpc({ method: "git-refs", repo: "proj" }, root);
    expect(r.exists).toBe(true);
    expect(r.head).toBe("main");
    expect(r.headSha).toBe(second);
    expect(r.branches).toEqual([{ name: "feature", sha: first }, { name: "main", sha: second }]);
  });
  it("answers exists:false for a plain folder", async () => {
    mkdirSync(path.join(root, "plain"));
    expect(await handleRpc({ method: "git-refs", repo: "plain" }, root)).toEqual({ method: "git-refs", exists: false });
  });
});

describe("git-ls-tree", () => {
  it("lists a folder at a ref, folders first, each with its last commit", async () => {
    const r = await handleRpc({ method: "git-ls-tree", repo: "proj", ref: "main", path: "" }, root);
    expect(r.sha).toBe(second);
    expect(r.entries.map((e) => [e.name, e.type])).toEqual([["lib", "tree"], ["ainize.json", "blob"], ["main.py", "blob"]]);
    const main = r.entries.find((e) => e.name === "main.py");
    expect(main.size).toBe(Buffer.byteLength("print('v2')\nprint('more')\n"));
    expect(main.lastCommit).toMatchObject({ sha: second, subject: "second: edit main", author: "Ann" });
    expect(r.entries.find((e) => e.name === "lib").lastCommit.sha).toBe(first);
    const sub = await handleRpc({ method: "git-ls-tree", repo: "proj", ref: "feature", path: "lib" }, root);
    expect(sub.sha).toBe(first);
    expect(sub.entries.map((e) => e.name)).toEqual(["util.py"]);
  });
  it("refuses an unknown ref, a missing path, and option-shaped refs", async () => {
    await expect(handleRpc({ method: "git-ls-tree", repo: "proj", ref: "nope", path: "" }, root)).rejects.toThrow(/unknown ref/);
    await expect(handleRpc({ method: "git-ls-tree", repo: "proj", ref: "main", path: "missing" }, root)).rejects.toThrow(/no such path/);
    await expect(handleRpc({ method: "git-ls-tree", repo: "proj", ref: "--output=/tmp/x", path: "" }, root)).rejects.toThrow(/invalid ref/);
    await expect(handleRpc({ method: "git-ls-tree", repo: "proj", ref: "main", path: "../x" }, root)).rejects.toThrow(/invalid path/);
    await expect(handleRpc({ method: "git-ls-tree", repo: "nope", ref: "main", path: "" }, root)).rejects.toThrow(/not a git repository/);
  });
});

describe("git-show", () => {
  it("reads the committed bytes at a ref — not the dirty working tree — base64, capped", async () => {
    const at = async (ref) => Buffer.from((await handleRpc({ method: "git-show", repo: "proj", ref, path: "main.py" }, root)).content, "base64").toString();
    expect(await at("main")).toBe("print('v2')\nprint('more')\n");
    expect(await at("feature")).toBe("print('v1')\n");
    expect(await at(first.slice(0, 8))).toBe("print('v1')\n");
    const capped = await handleRpc({ method: "git-show", repo: "proj", ref: "main", path: "main.py", maxBytes: 5 }, root);
    expect(capped.truncated).toBe(true);
    expect(capped.size).toBe(26);
    expect(Buffer.from(capped.content, "base64").toString()).toBe("print");
    await expect(handleRpc({ method: "git-show", repo: "proj", ref: "main", path: "lib" }, root)).rejects.toThrow(/is a directory/);
    await expect(handleRpc({ method: "git-show", repo: "proj", ref: "main", path: "nope.py" }, root)).rejects.toThrow(/no such path/);
  });
});

describe("git-log", () => {
  it("lists commits newest first, with parents and body, optionally for one path", async () => {
    const all = await handleRpc({ method: "git-log", repo: "proj", ref: "main", n: 10 }, root);
    expect(all.commits.map((c) => c.sha)).toEqual([second, first]);
    expect(all.commits[1]).toMatchObject({ subject: "first", body: "body line", author: "Ann", authorEmail: "ann@x.test", parents: [] });
    expect(all.commits[0].parents).toEqual([first]);
    expect(all.commits[0].date).toMatch(/^2026-10-01T10:00:00\+09:00$/);
    const lib = await handleRpc({ method: "git-log", repo: "proj", ref: "main", path: "lib/util.py", n: 10 }, root);
    expect(lib.commits.map((c) => c.sha)).toEqual([first]);
    const one = await handleRpc({ method: "git-log", repo: "proj", ref: "main", n: 1 }, root);
    expect(one.commits).toHaveLength(1);
  });
});

describe("git-commit-detail", () => {
  it("answers message, author, changed files with +/− and the patch", async () => {
    const r = await handleRpc({ method: "git-commit-detail", repo: "proj", sha: second }, root);
    expect(r).toMatchObject({ sha: second, subject: "second: edit main", author: "Ann", parents: [first], truncated: false });
    expect(r.files).toEqual([{ path: "main.py", additions: 2, deletions: 1 }]);
    expect(r.patch).toContain("-print('v1')");
    expect(r.patch).toContain("+print('v2')");
    const root0 = await handleRpc({ method: "git-commit-detail", repo: "proj", sha: first.slice(0, 7) }, root);
    expect(root0.files.map((f) => f.path).sort()).toEqual(["ainize.json", "lib/util.py", "main.py"]);
    expect(root0.body).toBe("body line");
  });
});
