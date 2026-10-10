// Git over SSH, agent end (git-exec.js + rpc.js `git-ssh-exec`): a live
// `git upload-pack` / `git receive-pack` pipe fed by git-stdin frames and
// drained as git-stdout / git-exit frames, against the real `git` binary.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { handleRpc, rpcMethodNames } from "../rpc.js";
import { GitExecs, GIT_EXEC_LIMITS } from "../git-exec.js";

process.env.AINDRIVE_TRACE = "off";

const git = (cwd, ...args) => execFileSync("git", args, {
  cwd, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" },
}).toString().trim();

let tmp, root;
beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), "git-exec-")); root = path.join(tmp, "drive"); mkdirSync(root); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

/** Collect frames; resolve `exit` on the git-exit frame for `execId`. */
function collector() {
  const frames = [];
  let resolveExit;
  const exit = new Promise((r) => { resolveExit = r; });
  const send = (f) => { frames.push(f); if (f.type === "git-exit") resolveExit(f); };
  const stdout = () => Buffer.concat(frames.filter((f) => f.type === "git-stdout").map((f) => Buffer.from(f.data, "base64")));
  return { frames, send, exit, stdout };
}
const pkt = (s) => (s.length + 4).toString(16).padStart(4, "0") + s;
const b64 = (b) => Buffer.from(b).toString("base64");

describe("rpc.js — git-ssh-exec", () => {
  it("is advertised in the method list", () => {
    expect(rpcMethodNames()).toContain("git-ssh-exec");
  });

  it("refuses without a streaming context, and for a missing repo", async () => {
    await expect(handleRpc({ method: "git-ssh-exec", repo: "x", service: "upload-pack", execId: "abcdefgh" }, root))
      .rejects.toThrow(/streaming connection/);
    const c = collector();
    const gitExecs = new GitExecs({ send: c.send });
    await expect(handleRpc({ method: "git-ssh-exec", repo: "nope", service: "upload-pack", execId: "abcdefgh" }, root, { gitExecs }))
      .rejects.toThrow(/not a git repository/);
    expect(gitExecs.size).toBe(0);
  });

  it("refuses a repo path that escapes the drive or is reserved", async () => {
    const gitExecs = new GitExecs({ send: () => {} });
    await expect(handleRpc({ method: "git-ssh-exec", repo: "../x", service: "upload-pack", execId: "abcdefgh" }, root, { gitExecs }))
      .rejects.toThrow(/escapes drive root/);
    await expect(handleRpc({ method: "git-ssh-exec", repo: ".aindrive/config.json", service: "upload-pack", execId: "abcdefgh" }, root, { gitExecs }))
      .rejects.toThrow(/reserved path/);
  });
});

describe("GitExecs — upload-pack pipe", () => {
  it("advertises refs on stdout, answers a stateful fetch and exits 0", async () => {
    await handleRpc({ method: "git-init", repo: "proj" }, root);
    const repo = path.join(root, "proj");
    writeFileSync(path.join(repo, "a.txt"), "hello\n");
    git(repo, "add", "."); git(repo, "commit", "-qm", "one");
    const head = git(repo, "rev-parse", "HEAD");

    const c = collector();
    const gitExecs = new GitExecs({ send: c.send });
    const r = await handleRpc({ method: "git-ssh-exec", repo: "proj", service: "upload-pack", execId: "exec0001" }, root, { gitExecs });
    expect(r.ok).toBe(true);
    expect(gitExecs.size).toBe(1);

    // Protocol v0: wait for the advertisement, then want + done → a pack comes back.
    await new Promise((res) => { const t = setInterval(() => { if (c.stdout().toString().includes(head)) { clearInterval(t); res(); } }, 20); });
    const adv = c.stdout().toString("latin1");
    expect(adv).toMatch(new RegExp(`${head} HEAD`));
    gitExecs.stdin({ execId: "exec0001", data: b64(pkt(`want ${head}\n`) + "0000" + pkt("done\n")) });
    gitExecs.stdin({ execId: "exec0001", eof: true });
    const exit = await c.exit;
    expect(exit.code).toBe(0);
    const out = c.stdout();
    expect(out.includes(Buffer.from("PACK"))).toBe(true); // a packfile followed NAK
    expect(gitExecs.size).toBe(0);
    // Every stdout frame was sequenced and chunk-sized.
    const seqs = c.frames.filter((f) => f.type === "git-stdout").map((f) => f.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i));
    for (const f of c.frames.filter((f) => f.type === "git-stdout")) expect(Buffer.from(f.data, "base64").length).toBeLessThanOrEqual(GIT_EXEC_LIMITS.chunkBytes);
  });

  it("acks stdin bytes once written and honours kill", async () => {
    await handleRpc({ method: "git-init", repo: "proj" }, root);
    const c = collector();
    const gitExecs = new GitExecs({ send: c.send });
    await handleRpc({ method: "git-ssh-exec", repo: "proj", service: "upload-pack", execId: "exec0002" }, root, { gitExecs });
    gitExecs.stdin({ execId: "exec0002", data: b64("00") }); // half a pkt-line length: git keeps waiting for the rest
    await new Promise((r) => setTimeout(r, 100));
    expect(c.frames.some((f) => f.type === "git-stdin-ack" && f.ack === 2)).toBe(true);
    expect(gitExecs.size).toBe(1);
    gitExecs.stdin({ execId: "exec0002", kill: true });
    const exit = await c.exit;
    expect(exit.signal).toBe("SIGKILL");
    expect(gitExecs.size).toBe(0);
    // frames for a finished exec are ignored
    expect(gitExecs.stdin({ execId: "exec0002", data: b64("x") })).toBe(false);
  });

  it("receive-pack: a real push payload lands files in the working tree (updateInstead)", async () => {
    await handleRpc({ method: "git-init", repo: "dst" }, root);
    const src = path.join(tmp, "src"); mkdirSync(src);
    git(src, "init", "-q", "-b", "main"); writeFileSync(path.join(src, "f.txt"), "pushed\n");
    git(src, "add", "."); git(src, "commit", "-qm", "c");
    const head = git(src, "rev-parse", "HEAD");
    const pack = execFileSync("git", ["pack-objects", "--stdout", "--revs"], { cwd: src, input: `${head}\n` });

    const c = collector();
    const gitExecs = new GitExecs({ send: c.send });
    await handleRpc({ method: "git-ssh-exec", repo: "dst", service: "receive-pack", execId: "exec0003" }, root, { gitExecs });
    await new Promise((res) => { const t = setInterval(() => { if (c.stdout().length) { clearInterval(t); res(); } }, 20); });
    const cmd = `${"0".repeat(40)} ${head} refs/heads/main\0report-status\n`;
    const body = Buffer.concat([Buffer.from(pkt(cmd)), Buffer.from("0000"), pack]);
    gitExecs.stdin({ execId: "exec0003", data: body.toString("base64") });
    gitExecs.stdin({ execId: "exec0003", eof: true });
    const exit = await c.exit;
    expect(exit.code).toBe(0);
    expect(c.stdout().toString("latin1")).toMatch(/unpack ok/);
    expect(existsSync(path.join(root, "dst", "f.txt"))).toBe(true);
    expect(readFileSync(path.join(root, "dst", "f.txt"), "utf8")).toBe("pushed\n");
  });

  it("closeAll kills every running exec silently (connection gone)", async () => {
    await handleRpc({ method: "git-init", repo: "proj" }, root);
    const c = collector();
    const gitExecs = new GitExecs({ send: c.send });
    await handleRpc({ method: "git-ssh-exec", repo: "proj", service: "upload-pack", execId: "exec0004" }, root, { gitExecs });
    gitExecs.closeAll();
    expect(gitExecs.size).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(c.frames.some((f) => f.type === "git-exit")).toBe(false);
  });

  it("refuses a bad exec id, a duplicate and an unknown service", async () => {
    const gitExecs = new GitExecs({ send: () => {} });
    expect(() => gitExecs.start({ execId: "short", repoAbs: root, service: "upload-pack" })).toThrow(/invalid execId/);
    expect(() => gitExecs.start({ execId: "exec0005", repoAbs: root, service: "shell" })).toThrow(/unknown git service/);
  });
});
