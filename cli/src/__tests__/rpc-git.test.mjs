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
  it("creates a non-bare repo on main with updateInstead + http.receivepack", async () => {
    const r = await handleRpc({ method: "git-init", repo: "proj" }, root);
    expect(r).toEqual({ method: "git-init", ok: true });
    const repo = path.join(root, "proj");
    expect(existsSync(path.join(repo, ".git", "HEAD"))).toBe(true);
    expect(existsSync(path.join(repo, "HEAD"))).toBe(false); // not bare
    expect(git(repo, "config", "receive.denyCurrentBranch")).toBe("updateInstead");
    expect(git(repo, "config", "http.receivepack")).toBe("true");
    expect(git(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  });

  it("is hidden from `list` as .git while the folder itself shows", async () => {
    await handleRpc({ method: "git-init", repo: "proj" }, root);
    const top = await handleRpc({ method: "list", path: "" }, root);
    expect(top.entries.map((e) => e.name)).toEqual(["proj"]);
    const inside = await handleRpc({ method: "list", path: "proj" }, root);
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

  it("into a git-init repo: the ref AND the working tree update (files visible in the drive)", async () => {
    await handleRpc({ method: "git-init", repo: "proj" }, root);
    const head = await pushInto("proj");
    const repo = path.join(root, "proj");
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(path.join(repo, "README.md"), "utf8")).toBe("hello drive\n");
    expect(git(repo, "status", "--porcelain")).toBe("");
    const listed = await handleRpc({ method: "list", path: "proj" }, root);
    expect(listed.entries.map((e) => e.name)).toEqual(["README.md"]);
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
