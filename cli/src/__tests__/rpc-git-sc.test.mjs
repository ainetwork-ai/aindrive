// Source control on a working copy (VS Code-like): git-status / git-stage /
// git-discard / git-commit (staged vs all) / git-push into the bare remote /
// git-pull, on the bare + working-copy layout git-init creates.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { handleRpc } from "../rpc.js";

process.env.AINDRIVE_TRACE = "off";
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: ENV }).toString().trim();

const WC = "repositories/proj", BARE = "repositories/proj.git";
let tmp, root, wc, bare;
const author = { authorName: "Ann", authorEmail: "ann@x.test" };
beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "rpc-git-sc-")); root = path.join(tmp, "drive"); mkdirSync(root);
  await handleRpc({ method: "git-init", repo: BARE }, root);
  wc = path.join(root, WC); bare = path.join(root, BARE);
  writeFileSync(path.join(wc, "a.txt"), "a\n"); writeFileSync(path.join(wc, "b.txt"), "b\n");
  await handleRpc({ method: "git-commit", repo: WC, message: "init", all: true, ...author }, root);
  await handleRpc({ method: "git-push", repo: WC }, root);
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("git-status", () => {
  it("lists staged / unstaged / untracked with VS Code letters, the branch and ahead/behind vs origin", async () => {
    writeFileSync(path.join(wc, "a.txt"), "a2\n");           // modified, unstaged
    writeFileSync(path.join(wc, "new.txt"), "n\n");          // untracked
    git(wc, "rm", "-q", "b.txt");                              // deletion, staged
    writeFileSync(path.join(wc, "c.txt"), "c\n"); git(wc, "add", "c.txt"); // added, staged
    const st = await handleRpc({ method: "git-status", repo: WC }, root);
    expect(st.branch).toBe("main");
    expect(st.staged).toEqual([{ path: "b.txt", status: "D" }, { path: "c.txt", status: "A" }]);
    expect(st.unstaged).toEqual([{ path: "a.txt", status: "M" }]);
    expect(st.untracked).toEqual([{ path: "new.txt", status: "U" }]);
    expect(st).toMatchObject({ ahead: 0, behind: 0, hasRemote: true });
  });
  it("counts commits ahead of the bare", async () => {
    writeFileSync(path.join(wc, "a.txt"), "a2\n");
    await handleRpc({ method: "git-commit", repo: WC, message: "edit", all: true, ...author }, root);
    expect((await handleRpc({ method: "git-status", repo: WC }, root)).ahead).toBe(1);
    const meta = await handleRpc({ method: "git-meta", repo: WC }, root);
    expect(meta).toMatchObject({ layout: "working-copy", ahead: 1, behind: 0 });
  });
});

describe("git-stage / git-discard", () => {
  it("stages, unstages, and discards tracked edits and untracked files", async () => {
    writeFileSync(path.join(wc, "a.txt"), "a2\n"); writeFileSync(path.join(wc, "new.txt"), "n\n");
    await handleRpc({ method: "git-stage", repo: WC, paths: ["a.txt", "new.txt"] }, root);
    let st = await handleRpc({ method: "git-status", repo: WC }, root);
    expect(st.staged.map((f) => f.path + f.status)).toEqual(["a.txtM", "new.txtA"]);
    await handleRpc({ method: "git-stage", repo: WC, paths: ["new.txt"], unstage: true }, root);
    st = await handleRpc({ method: "git-status", repo: WC }, root);
    expect(st.staged.map((f) => f.path)).toEqual(["a.txt"]);
    expect(st.untracked.map((f) => f.path)).toEqual(["new.txt"]);
    const d = await handleRpc({ method: "git-discard", repo: WC, paths: ["new.txt"] }, root);
    expect(d).toMatchObject({ untracked: 1, tracked: 0 });
    expect(existsSync(path.join(wc, "new.txt"))).toBe(false);
    // discarding a tracked file returns it to the index (still staged "a2") — unstage first to go back to HEAD
    await handleRpc({ method: "git-stage", repo: WC, paths: ["a.txt"], unstage: true }, root);
    await handleRpc({ method: "git-discard", repo: WC, paths: ["a.txt"] }, root);
    expect(readFileSync(path.join(wc, "a.txt"), "utf8")).toBe("a\n");
    await expect(handleRpc({ method: "git-stage", repo: WC, paths: ["../x"] }, root)).rejects.toThrow(/invalid path/);
    await expect(handleRpc({ method: "git-stage", repo: WC, paths: [] }, root)).rejects.toThrow(/paths required/);
    await expect(handleRpc({ method: "git-stage", repo: BARE, paths: ["a"] }, root)).rejects.toThrow(/not a git repository/);
  });
});

describe("git-commit (staged vs all)", () => {
  it("without `all` commits only what is staged; with nothing staged it refuses", async () => {
    writeFileSync(path.join(wc, "a.txt"), "a2\n"); writeFileSync(path.join(wc, "b.txt"), "b2\n");
    await expect(handleRpc({ method: "git-commit", repo: WC, message: "m", all: false, ...author }, root)).rejects.toThrow(/nothing staged/);
    await handleRpc({ method: "git-stage", repo: WC, paths: ["a.txt"] }, root);
    const r = await handleRpc({ method: "git-commit", repo: WC, message: "only a", all: false, ...author }, root);
    expect(git(wc, "show", "--stat", "--format=", r.sha)).toContain("a.txt");
    expect(git(wc, "show", "--stat", "--format=", r.sha)).not.toContain("b.txt");
    const st = await handleRpc({ method: "git-status", repo: WC }, root);
    expect(st.unstaged).toEqual([{ path: "b.txt", status: "M" }]);
  });
});

describe("git-push / git-pull", () => {
  it("push moves the bare's branch to the working copy's HEAD and reports before/after", async () => {
    const before = git(bare, "rev-parse", "refs/heads/main");
    writeFileSync(path.join(wc, "a.txt"), "a2\n");
    await handleRpc({ method: "git-commit", repo: WC, message: "edit", all: true, ...author }, root);
    const r = await handleRpc({ method: "git-push", repo: WC }, root);
    expect(r).toEqual({ method: "git-push", ok: true, ref: "refs/heads/main", before, after: git(wc, "rev-parse", "HEAD") });
    expect(git(bare, "rev-parse", "refs/heads/main")).toBe(r.after);
    expect((await handleRpc({ method: "git-status", repo: WC }, root)).ahead).toBe(0);
  });
  it("pull fast-forwards a clean working copy and refuses a dirty one", async () => {
    // someone else pushes to the bare
    const other = path.join(tmp, "other");
    git(tmp, "clone", "-q", bare, "other");
    writeFileSync(path.join(other, "z.txt"), "z\n"); git(other, "add", "."); git(other, "commit", "-qm", "z"); git(other, "push", "-q", "origin", "main");
    const st = await handleRpc({ method: "git-status", repo: WC }, root);
    expect(st.behind).toBe(1);
    writeFileSync(path.join(wc, "a.txt"), "dirty\n");
    await expect(handleRpc({ method: "git-pull", repo: WC }, root)).rejects.toThrow(/has changes/);
    await handleRpc({ method: "git-discard", repo: WC, paths: ["a.txt"] }, root);
    const p = await handleRpc({ method: "git-pull", repo: WC }, root);
    expect(p.sha).toBe(git(bare, "rev-parse", "refs/heads/main"));
    expect(existsSync(path.join(wc, "z.txt"))).toBe(true);
  });
  it("a legacy non-bare repo has no remote to push to", async () => {
    const legacy = path.join(root, "legacy"); mkdirSync(legacy); git(legacy, "init", "-q", "-b", "main");
    await expect(handleRpc({ method: "git-push", repo: "legacy" }, root)).rejects.toThrow(/legacy layout/);
  });
});
