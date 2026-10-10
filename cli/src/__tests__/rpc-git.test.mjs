// handleRpc git methods (git-init / git-advertise / git-service) against the
// real `git` binary on a tmp drive root.
//
// git-init creates a NON-bare repo with receive.denyCurrentBranch=updateInstead
// so a push lands the files in the drive as ordinary files; advertise/service
// accept both that and a legacy bare repo (repos made before this change).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { handleRpc } from "../rpc.js";

process.env.AINDRIVE_TRACE = "off";

const git = (cwd, ...args) => execFileSync("git", args, {
  cwd, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" },
}).toString().trim();

let tmp, root;
beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), "rpc-git-")); root = path.join(tmp, "drive"); mkdirSync(root); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

// The request body `git push` sends to `git receive-pack --stateless-rpc`:
// one pkt-line update command (old new ref\0caps), a flush, then the packfile —
// the pack itself comes from the real `git pack-objects`.
function receivePackInput(srcRepo, head) {
  const cmd = `${"0".repeat(40)} ${head} refs/heads/main\0report-status\n`;
  const pkt = Buffer.from((Buffer.byteLength(cmd) + 4).toString(16).padStart(4, "0") + cmd);
  const pack = execFileSync("git", ["pack-objects", "--stdout", "--revs"], { cwd: srcRepo, input: `${head}\n`, stdio: ["pipe", "pipe", "pipe"] });
  return Buffer.concat([pkt, Buffer.from("0000"), pack]);
}

describe("handleRpc — git-init", () => {
  it("creates the bare remote <repo>.git (main, http.receivepack) AND an empty working copy <repo>/ with origin = ../<repo>.git", async () => {
    const r = await handleRpc({ method: "git-init", repo: "repositories/proj.git" }, root);
    expect(r).toEqual({ method: "git-init", ok: true, bare: "repositories/proj.git", workingCopy: "repositories/proj" });
    const bare = path.join(root, "repositories/proj.git");
    const wc = path.join(root, "repositories/proj");
    expect(existsSync(path.join(bare, "HEAD"))).toBe(true);
    expect(existsSync(path.join(bare, "objects"))).toBe(true);
    expect(git(bare, "config", "core.bare")).toBe("true");
    expect(git(bare, "config", "http.receivepack")).toBe("true");
    expect(git(bare, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
    expect(existsSync(path.join(wc, ".git", "HEAD"))).toBe(true);
    expect(git(wc, "remote", "get-url", "origin")).toBe("../proj.git");
    expect(git(wc, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
    // a name without the suffix gets it
    await handleRpc({ method: "git-init", repo: "repositories/other" }, root);
    expect(existsSync(path.join(root, "repositories/other.git", "HEAD"))).toBe(true);
    await expect(handleRpc({ method: "git-init", repo: "repositories/proj.git" }, root)).rejects.toThrow(/exists/);
  });

  it("hides the bare remote and `.git` from `list`; the working copy shows", async () => {
    await handleRpc({ method: "git-init", repo: "repositories/proj.git" }, root);
    const top = await handleRpc({ method: "list", path: "repositories" }, root);
    expect(top.entries.map((e) => e.name)).toEqual(["proj"]);
    const inside = await handleRpc({ method: "list", path: "repositories/proj" }, root);
    expect(inside.entries).toEqual([]);
  });
});

describe("handleRpc — git-advertise", () => {
  it("reports exists:false for a plain folder and for a missing path", async () => {
    mkdirSync(path.join(root, "folder"));
    expect(await handleRpc({ method: "git-advertise", repo: "folder", service: "upload-pack" }, root))
      .toEqual({ method: "git-advertise", exists: false, data: "" });
    expect(await handleRpc({ method: "git-advertise", repo: "missing", service: "receive-pack" }, root))
      .toEqual({ method: "git-advertise", exists: false, data: "" });
  });

  it("advertises a non-bare repo made by git-init", async () => {
    await handleRpc({ method: "git-init", repo: "proj" }, root);
    const r = await handleRpc({ method: "git-advertise", repo: "proj", service: "receive-pack" }, root);
    expect(r.exists).toBe(true);
    const text = Buffer.from(r.data, "base64").toString();
    expect(text).toMatch(/capabilities\^\{\}/); // empty repo: capabilities line only
    expect(text).toContain("report-status");
  });

  it("still advertises a legacy BARE repo (both services)", async () => {
    git(root, "init", "-q", "--bare", "--initial-branch=main", "legacy.git");
    // Give it a commit over the file transport so upload-pack has a ref to show
    // (what an empty repo advertises differs between git versions).
    const src = path.join(tmp, "src"); mkdirSync(src);
    git(src, "init", "-q", "-b", "main");
    writeFileSync(path.join(src, "a.txt"), "a\n");
    git(src, "add", "-A"); git(src, "commit", "-q", "-m", "one");
    git(src, "push", "-q", path.join(root, "legacy.git"), "main");
    for (const service of ["upload-pack", "receive-pack"]) {
      const r = await handleRpc({ method: "git-advertise", repo: "legacy.git", service }, root);
      expect(r.exists, service).toBe(true);
      expect(Buffer.from(r.data, "base64").toString(), service).toContain("refs/heads/main");
    }
  });
});

describe("handleRpc — git-service (receive-pack)", () => {
  async function pushInto(repoRel) {
    // source repo with one commit
    const src = path.join(tmp, "src");
    mkdirSync(src);
    git(src, "init", "-q", "-b", "main");
    writeFileSync(path.join(src, "README.md"), "hello drive\n");
    git(src, "add", "-A"); git(src, "commit", "-q", "-m", "one");
    const head = git(src, "rev-parse", "HEAD");

    const adv = await handleRpc({ method: "git-advertise", repo: repoRel, service: "receive-pack" }, root);
    expect(adv.exists).toBe(true);
    const input = receivePackInput(src, head);

    const inRel = ".aindrive/uploads/git/t.in", outRel = ".aindrive/uploads/git/t.out";
    mkdirSync(path.join(root, ".aindrive/uploads/git"), { recursive: true });
    writeFileSync(path.join(root, inRel), input);
    const r = await handleRpc({ method: "git-service", repo: repoRel, service: "receive-pack", in: inRel, out: outRel }, root);
    expect(r.ok).toBe(true);
    expect(r.size).toBeGreaterThan(0);
    const out = readFileSync(path.join(root, outRel)).toString();
    expect(out).toContain("unpack ok");
    expect(out).toContain("ok refs/heads/main");
    return head;
  }

  it("into a git-init bare: the bare's ref updates and the CLEAN working copy fast-forwards (files visible in the drive)", async () => {
    await handleRpc({ method: "git-init", repo: "repositories/proj.git" }, root);
    const head = await pushInto("repositories/proj.git");
    const bare = path.join(root, "repositories/proj.git");
    const wc = path.join(root, "repositories/proj");
    expect(git(bare, "rev-parse", "HEAD")).toBe(head);
    expect(git(wc, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(path.join(wc, "README.md"), "utf8")).toBe("hello drive\n");
    expect(git(wc, "status", "--porcelain")).toBe("");
    expect(git(wc, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main");
    const listed = await handleRpc({ method: "list", path: "repositories/proj" }, root);
    expect(listed.entries.map((e) => e.name)).toEqual(["README.md"]);
  });

  it("a DIRTY working copy is never touched by a push: it stays as it was and git-status says behind", async () => {
    await handleRpc({ method: "git-init", repo: "repositories/proj.git" }, root);
    const wc = path.join(root, "repositories/proj");
    writeFileSync(path.join(wc, "draft.txt"), "unsaved work\n");
    const head = await pushInto("repositories/proj.git");
    expect(git(path.join(root, "repositories/proj.git"), "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(path.join(wc, "README.md"))).toBe(false);
    expect(readFileSync(path.join(wc, "draft.txt"), "utf8")).toBe("unsaved work\n");
    // unborn HEAD: no ahead/behind can be counted yet, but the remote is known
    const st = await handleRpc({ method: "git-status", repo: "repositories/proj" }, root);
    expect(st.untracked).toEqual([{ path: "draft.txt", status: "U" }]);
    expect(st.hasRemote).toBe(true);
    // discard the draft → pull fast-forwards
    await handleRpc({ method: "git-discard", repo: "repositories/proj", paths: ["draft.txt"] }, root);
    expect(existsSync(path.join(wc, "draft.txt"))).toBe(false);
    const pulled = await handleRpc({ method: "git-pull", repo: "repositories/proj" }, root);
    expect(pulled.sha).toBe(head);
    expect(readFileSync(path.join(wc, "README.md"), "utf8")).toBe("hello drive\n");
  });

  it("into a legacy bare repo: the ref updates, no working tree appears", async () => {
    git(root, "init", "-q", "--bare", "--initial-branch=main", "legacy.git");
    const head = await pushInto("legacy.git");
    expect(git(path.join(root, "legacy.git"), "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(path.join(root, "legacy.git", "README.md"))).toBe(false);
  });

  it("refuses a path that is not a repository", async () => {
    mkdirSync(path.join(root, "folder"));
    mkdirSync(path.join(root, ".aindrive/uploads/git"), { recursive: true });
    writeFileSync(path.join(root, ".aindrive/uploads/git/x.in"), "");
    await expect(handleRpc({ method: "git-service", repo: "folder", service: "upload-pack", in: ".aindrive/uploads/git/x.in", out: ".aindrive/uploads/git/x.out" }, root))
      .rejects.toThrow("not a git repository");
  });
});

// Web git panel: git-meta (read-only summary) and git-commit (commit all as
// the signed-in user), on a real repo in the drive.
describe("handleRpc — git-meta", () => {
  it("reports exists:false for a plain folder", async () => {
    mkdirSync(path.join(root, "folder"));
    expect(await handleRpc({ method: "git-meta", repo: "folder" }, root)).toEqual({ method: "git-meta", exists: false });
  });

  it("describes an unborn working copy (fresh git-init) without a HEAD commit", async () => {
    await handleRpc({ method: "git-init", repo: "repositories/proj.git" }, root);
    const r = await handleRpc({ method: "git-meta", repo: "repositories/proj" }, root);
    expect(r).toEqual({ method: "git-meta", exists: true, branch: "main", head: null, dirty: 0, commits: [], layout: "working-copy", ahead: 0, behind: 0 });
  });

  it("calls a non-bare repo without a bare sibling `legacy`", async () => {
    const repo = path.join(root, "proj"); mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    const r = await handleRpc({ method: "git-meta", repo: "proj" }, root);
    expect(r.layout).toBe("legacy");
  });

  it("returns branch, HEAD, the last 10 commits (newest first) and the dirty count", async () => {
    const repo = path.join(root, "proj"); mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    for (let i = 1; i <= 12; i++) {
      writeFileSync(path.join(repo, "f.txt"), `v${i}\n`);
      git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", `commit ${i}`);
    }
    writeFileSync(path.join(repo, "dirty-a.txt"), "a\n");
    writeFileSync(path.join(repo, "f.txt"), "changed\n");
    const r = await handleRpc({ method: "git-meta", repo: "proj" }, root);
    expect(r.exists).toBe(true);
    expect(r.branch).toBe("main");
    expect(r.commits).toHaveLength(10);
    expect(r.commits[0].subject).toBe("commit 12");
    expect(r.commits[9].subject).toBe("commit 3");
    expect(r.head.sha).toBe(git(repo, "rev-parse", "HEAD"));
    expect(r.head.author).toBe("t");
    expect(r.head.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.dirty).toBe(2);
  });

  it("refuses a path that escapes the drive", async () => {
    await expect(handleRpc({ method: "git-meta", repo: "../x" }, root)).rejects.toThrow(/escapes/);
  });
});

describe("handleRpc — git-commit", () => {
  it("commits all changes with the given identity and returns the sha", async () => {
    await handleRpc({ method: "git-init", repo: "proj" }, root);
    const repo = path.join(root, "proj");
    writeFileSync(path.join(repo, "a.py"), "print(1)\n");
    const r = await handleRpc({ method: "git-commit", repo: "proj", message: "first", authorName: "Min Kim", authorEmail: "min@example.com" }, root);
    expect(r.method).toBe("git-commit");
    expect(r.sha).toBe(git(repo, "rev-parse", "HEAD"));
    expect(git(repo, "log", "-1", "--format=%an <%ae> %s")).toBe("Min Kim <min@example.com> first");
    expect(git(repo, "status", "--porcelain")).toBe("");
    // The identity was passed per-invocation, not written into the repo.
    expect(() => git(repo, "config", "--local", "user.name")).toThrow();
    const meta = await handleRpc({ method: "git-meta", repo: "proj" }, root);
    expect(meta.head.sha).toBe(r.sha);
    expect(meta.dirty).toBe(0);
  });

  it("refuses an empty message, a clean tree and a non-repo with clear errors", async () => {
    await handleRpc({ method: "git-init", repo: "proj" }, root);
    writeFileSync(path.join(root, "proj", "a.txt"), "x\n");
    await expect(handleRpc({ method: "git-commit", repo: "proj", message: "   " }, root)).rejects.toThrow("commit message required");
    await handleRpc({ method: "git-commit", repo: "proj", message: "ok" }, root);
    await expect(handleRpc({ method: "git-commit", repo: "proj", message: "again" }, root)).rejects.toThrow("nothing to commit");
    mkdirSync(path.join(root, "plain"));
    await expect(handleRpc({ method: "git-commit", repo: "plain", message: "m" }, root)).rejects.toThrow("not a git repository");
  });
});
