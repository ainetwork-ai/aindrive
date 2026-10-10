#!/usr/bin/env node
// Git-over-SSH end-to-end harness (not a vitest; run by hand from web/):
//
//   node scripts/build-ssh-server.mjs && node scripts/git-ssh-harness.mjs
//
// Boots, IN THIS PROCESS, the real agent WebSocket endpoint (lib/agents.js) and
// the bundled SSH server (.ssh-server/ssh-server.mjs) on a temp data dir with a
// FAKE AIN SSO key directory, spawns the real cli agent (cli/src/agent.js) on a
// temp drive root, then drives it with the real `git` and `ssh` binaries and
// throwaway keys: clone-before-push refused, push creates the repo + working
// tree (updateInstead), clone back, second push, incremental fetch, a 40 MB
// push/clone through the flow-control window, d/<driveId>/ form, unknown /
// unlinked / suspended keys, wrong username, viewer can clone but not push,
// editor creates a nested repo, non-git commands, traversal, reserved path,
// unknown org, shell request. Exit 0 iff every check passed. Needs `ssh`,
// `ssh-keygen`, `git` on PATH and cli/node_modules installed.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(WEB, "..");
const base = mkdtempSync(join(process.env.SCRATCH || tmpdir(), "git-ssh-harness-"));
const dataDir = join(base, "data"); mkdirSync(dataDir);
const driveRoot = join(base, "drive"); mkdirSync(join(driveRoot, ".aindrive"), { recursive: true });
const work = join(base, "work"); mkdirSync(work);
const keys = join(base, "keys"); mkdirSync(keys);

process.env.AINDRIVE_DATA_DIR = dataDir;
process.env.AINDRIVE_SESSION_SECRET = "harness-secret-0123456789abcdef0123456789";
process.env.AINDRIVE_PUBLIC_URL = "http://127.0.0.1:1";
process.env.AINDRIVE_SSO_ISSUER = "https://sso.example.test";
process.env.AINDRIVE_SSO_CLIENT_ID = "app_aindrive";
process.env.AINDRIVE_TRACE = "off";
process.env.AINDRIVE_LOG_LEVEL = process.env.AINDRIVE_LOG_LEVEL || "warn";
process.env.NODE_ENV = "test";

const require = createRequire(`${WEB}/package.json`);
const bcrypt = require("bcryptjs");
const { WebSocketServer } = require("ws");

const { db } = await import(`${WEB}/lib/db.js`);
const agents = await import(`${WEB}/lib/agents.js`);
const orgs = await import(`${WEB}/lib/orgs.js`);
const sshMod = await import(`${WEB}/.ssh-server/ssh-server.mjs`);

// ---- fixtures: users, drive, org share, member ----
const ISSUER = process.env.AINDRIVE_SSO_ISSUER;
const ins = db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)");
for (const u of ["u-owner", "u-editor", "u-viewer", "u-blocked", "u-stranger"]) ins.run(u, `${u}@example.test`, u, "x");
const driveId = "drv" + randomBytes(5).toString("hex");
const agentToken = randomBytes(24).toString("hex");
const driveSecret = randomBytes(24).toString("hex");
db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)")
  .run(driveId, "u-owner", "ComCom Drive", bcrypt.hashSync(agentToken, 4), driveSecret);
const ident = db.prepare("INSERT INTO sso_identities (issuer, subject, user_id, link_method, linked_at) VALUES (?,?,?,?,?)");
ident.run(ISSUER, "acc_owner", "u-owner", "jit", Date.now());
ident.run(ISSUER, "acc_editor", "u-editor", "jit", Date.now());
ident.run(ISSUER, "acc_viewer", "u-viewer", "jit", Date.now());
ident.run(ISSUER, "acc_blocked", "u-blocked", "jit", Date.now());
// acc_unlinked: known key at SSO, no aindrive account
const mem = db.prepare(`INSERT INTO sso_memberships (issuer, org_id, subject, user_id, org_slug, org_name, status, app_role, groups_json, applied_version, updated_at)
  VALUES (?, 'org_comcom', ?, ?, 'comcom', 'ComCom', ?, 'member', '[]', 1, ?)`);
mem.run(ISSUER, "acc_owner", "u-owner", "active", Date.now());
mem.run(ISSUER, "acc_viewer", "u-viewer", "active", Date.now());
mem.run(ISSUER, "acc_editor", "u-editor", "active", Date.now());
mem.run(ISSUER, "acc_blocked", "u-blocked", "suspended", Date.now());
// org share → every active member is a VIEWER of the whole drive (slug `comcom` → this drive)
orgs.shareDriveWithOrg({ driveId, issuer: ISSUER, orgId: "org_comcom", role: "viewer", actor: "operator", via: "operator" });
// a personal editor grant for u-editor
db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)").run("m1", driveId, "u-editor", "", "editor");

// ---- throwaway SSH keys + fake directory ----
function keygen(name) {
  const p = join(keys, name);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", p]);
  const pub = readFileSync(p + ".pub", "utf8").trim();
  const blob = Buffer.from(pub.split(/\s+/)[1], "base64");
  const fp = "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
  return { path: p, pub, fp };
}
const K = { owner: keygen("owner"), editor: keygen("editor"), viewer: keygen("viewer"), blocked: keygen("blocked"), unlinked: keygen("unlinked"), stranger: keygen("stranger") };
const directoryRows = new Map([
  [K.owner.fp, { subject: "acc_owner", public_key: K.owner.pub }],
  [K.editor.fp, { subject: "acc_editor", public_key: K.editor.pub }],
  [K.viewer.fp, { subject: "acc_viewer", public_key: K.viewer.pub }],
  [K.blocked.fp, { subject: "acc_blocked", public_key: K.blocked.pub }],
  [K.unlinked.fp, { subject: "acc_unlinked", public_key: K.unlinked.pub }],
]);
let lookups = 0;
const directory = {
  async byFingerprint(fp) { lookups++; const r = directoryRows.get(fp); return r ? { ...r, fingerprint: fp, key_type: "ssh-ed25519" } : null; },
  async bySubject() { return []; },
};

// ---- web side: agent WS endpoint + ssh server ----
const http = createServer((_q, r) => { r.statusCode = 404; r.end(); });
const wss = new WebSocketServer({ noServer: true, maxPayload: 160 * 1024 * 1024 });
http.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/api/agent/connect") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => agents.onAgentConnect(ws, req, { driveId: url.searchParams.get("driveId") }).catch((e) => { console.error("connect err", e); ws.close(1011); }));
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const wsPort = http.address().port;
const sshPort = 20000 + Math.floor(Math.random() * 20000);
const sshServer = await sshMod.startGitSshServer({ port: sshPort, host: "127.0.0.1", hostKeyPath: join(dataDir, "ssh_host_ed25519_key"), directory, issuer: ISSUER });
if (!sshServer) throw new Error("ssh server did not start");
console.log(`[harness] ws :${wsPort}  ssh :${sshPort}  drive ${driveId}  root ${driveRoot}`);
console.log(`[harness] host key generated: ${existsSync(join(dataDir, "ssh_host_ed25519_key"))} pub: ${readFileSync(join(dataDir, "ssh_host_ed25519_key.pub"), "utf8").trim().slice(0, 40)}…`);

// ---- the real cli agent, as a child process ----
writeFileSync(join(base, "agent.mjs"), `
import { runAgent } from "${REPO}/cli/src/agent.js";
await runAgent({ root: ${JSON.stringify(driveRoot)}, drive: { driveId: ${JSON.stringify(driveId)}, agentToken: ${JSON.stringify(agentToken)}, driveSecret: ${JSON.stringify(driveSecret)} }, server: "http://127.0.0.1:${wsPort}" });
`);
const agent = spawn(process.execPath, [join(base, "agent.mjs")], { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, AINDRIVE_LOG_LEVEL: process.env.AGENT_LOG_LEVEL || "warn" } });
for (let i = 0; i < 100 && !agents.isAgentConnected(driveId); i++) await new Promise((r) => setTimeout(r, 100));
console.log(`[harness] agent connected: ${agents.isAgentConnected(driveId)}`);

// ---- git/ssh helpers ----
const sshCmd = (key) => `ssh -i ${key.path} -p ${sshPort} -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=${join(base, "known_hosts")} -o BatchMode=yes`;
const gitEnv = (key) => ({ ...process.env, GIT_SSH_COMMAND: sshCmd(key), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x", GIT_TERMINAL_PROMPT: "0" });
const results = [];
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => p.kill("SIGKILL"), opts.timeout ?? 120_000);
    p.on("close", (code) => { clearTimeout(t); resolve({ code, status: code, out: out.trim(), err: err.trim(), stdout: out, stderr: err }); });
    if (opts.input !== undefined) p.stdin.end(opts.input); else p.stdin.end();
  });
}
const git = (key, cwd, ...args) => run("git", args, { cwd, env: gitEnv(key) });
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "\n      " + String(detail).split("\n").join("\n      ") : ""}`);
}
const REMOTE = `git@127.0.0.1:comcom/clef-artwork-search`;

try {
  // 1. clone a path with no repo yet → refused, nothing revealed
  let r = await git(K.owner, work, "clone", REMOTE, "empty-clone");
  check("clone of a not-yet-existing repo fails with 'repository not found'", r.code !== 0 && /repository not found/.test(r.err), r.err);

  // 2. first push creates the repo (git-init, updateInstead) and the working tree
  const src = join(work, "src"); mkdirSync(src);
  await git(K.owner, src, "init", "-q", "-b", "main");
  writeFileSync(join(src, "README.md"), "# clef artwork search\n");
  mkdirSync(join(src, "data")); writeFileSync(join(src, "data", "blob.bin"), randomBytes(2 * 1024 * 1024));
  await git(K.owner, src, "add", "."); await git(K.owner, src, "commit", "-q", "-m", "first");
  r = await git(K.owner, src, "push", REMOTE, "main");
  check("first push (owner key) succeeds", r.code === 0, r.err);
  const tree = existsSync(join(driveRoot, "clef-artwork-search", "README.md"));
  check("pushed files appear in the drive working tree (updateInstead)", tree && existsSync(join(driveRoot, "clef-artwork-search", ".git", "HEAD")), existsSync(join(driveRoot, "clef-artwork-search")) ? readdirSync(join(driveRoot, "clef-artwork-search")).join(", ") : "(no dir)");

  // 3. clone back (stateful upload-pack negotiation over SSH, GIT_PROTOCOL=version=2 by default)
  r = await git(K.owner, work, "clone", REMOTE, "back");
  check("clone back succeeds", r.code === 0 && readFileSync(join(work, "back", "README.md"), "utf8").startsWith("# clef"), r.err);
  const log1 = await git(K.owner, join(work, "back"), "log", "--oneline");
  check("clone has the pushed commit", /first/.test(log1.out), log1.out);

  // 4. second push updates files (negotiation with existing refs)
  writeFileSync(join(src, "README.md"), "# clef artwork search\n\nsecond\n");
  await git(K.owner, src, "commit", "-qam", "second");
  r = await git(K.owner, src, "push", REMOTE, "main");
  check("second push succeeds", r.code === 0, r.err);
  check("working tree updated by second push", /second/.test(readFileSync(join(driveRoot, "clef-artwork-search", "README.md"), "utf8")));
  r = await git(K.owner, join(work, "back"), "fetch", "origin");
  const ff = await git(K.owner, join(work, "back"), "merge", "--ff-only", "origin/main");
  const log2 = await git(K.owner, join(work, "back"), "log", "--oneline");
  check("fetch of the update into the clone succeeds (incremental negotiation)", r.code === 0 && ff.code === 0 && /second/.test(log2.out), `fetch exit=${r.code} ${r.err}\nmerge exit=${ff.code} ${ff.out}\n${log2.out}`);

  // 4b. a large push + clone: 40 MB of incompressible data crosses the 4 MiB flow-control window many times
  writeFileSync(join(src, "data", "big.bin"), randomBytes(40 * 1024 * 1024));
  await git(K.owner, src, "add", "."); await git(K.owner, src, "commit", "-qm", "big");
  let t0 = Date.now();
  r = await git(K.owner, src, "push", REMOTE, "main");
  check(`large push (40 MB) succeeds in ${Date.now() - t0} ms`, r.code === 0, r.err);
  const bigSha = createHash("sha256").update(readFileSync(join(src, "data", "big.bin"))).digest("hex");
  check("large pushed file is byte-identical in the drive working tree", existsSync(join(driveRoot, "clef-artwork-search", "data", "big.bin")) && createHash("sha256").update(readFileSync(join(driveRoot, "clef-artwork-search", "data", "big.bin"))).digest("hex") === bigSha);
  t0 = Date.now();
  r = await git(K.owner, work, "clone", REMOTE, "big-clone");
  check(`large clone (40 MB) succeeds in ${Date.now() - t0} ms`, r.code === 0 && createHash("sha256").update(readFileSync(join(work, "big-clone", "data", "big.bin"))).digest("hex") === bigSha, r.err);

  // 5. explicit d/<driveId>/<repo> form
  r = await git(K.owner, work, "clone", `git@127.0.0.1:d/${driveId}/clef-artwork-search.git`, "by-id");
  check("clone via d/<driveId>/<repo>.git works", r.code === 0, r.err);

  // 6. wrong key (unknown to SSO) → auth refused
  r = await git(K.stranger, work, "clone", REMOTE, "stranger");
  check("unknown key: authentication refused", r.code !== 0 && /Permission denied \(publickey\)/.test(r.err), r.err);
  // 6b. key known to SSO but subject not linked to an aindrive account
  r = await git(K.unlinked, work, "clone", REMOTE, "unlinked");
  check("SSO key with no linked aindrive account: refused", r.code !== 0 && /Permission denied \(publickey\)/.test(r.err), r.err);
  // 6c. blocked (suspended) account
  r = await git(K.blocked, work, "clone", REMOTE, "blocked");
  check("suspended account's key: refused", r.code !== 0 && /Permission denied \(publickey\)/.test(r.err), r.err);
  // 6d. username other than git
  const u = await run("ssh", [...sshCmd(K.owner).split(" ").slice(1), "nobody@127.0.0.1", "git-upload-pack 'comcom/x'"], { timeout: 30_000 });
  check("username other than `git`: refused", u.status !== 0 && /Permission denied/.test(u.stderr), u.stderr.trim());

  // 7. viewer (org member, viewer role): clone works, push refused
  r = await git(K.viewer, work, "clone", REMOTE, "viewer-clone");
  check("viewer key: clone works", r.code === 0, r.err);
  writeFileSync(join(work, "viewer-clone", "evil.txt"), "x"); await git(K.viewer, join(work, "viewer-clone"), "add", "."); await git(K.viewer, join(work, "viewer-clone"), "commit", "-qm", "evil");
  r = await git(K.viewer, join(work, "viewer-clone"), "push", REMOTE, "main");
  check("viewer key: push refused (editor required)", r.code !== 0 && /permission denied/.test(r.err), r.err);
  check("viewer push left the drive untouched", !existsSync(join(driveRoot, "clef-artwork-search", "evil.txt")));

  // 7b. editor (drive_members editor): push to a NEW path creates it
  const e = join(work, "editor-src"); mkdirSync(e); await git(K.editor, e, "init", "-q", "-b", "main");
  writeFileSync(join(e, "a.txt"), "editor\n"); await git(K.editor, e, "add", "."); await git(K.editor, e, "commit", "-qm", "e");
  r = await git(K.editor, e, "push", `git@127.0.0.1:comcom/sub/dir/newrepo`, "main");
  check("editor key: push creates a repo at a nested new path", r.code === 0 && existsSync(join(driveRoot, "sub", "dir", "newrepo", "a.txt")), r.err);

  // 8. bad commands
  const bad = (cmd) => run("ssh", [...sshCmd(K.owner).split(" ").slice(1), "git@127.0.0.1", cmd], { timeout: 30_000 });
  let b = await bad("ls -la");
  check("`ls -la`: refused", b.status === 1 && /only git-upload-pack and git-receive-pack/.test(b.stderr), b.stderr.trim());
  b = await bad("git-upload-pack 'comcom/../../etc'");
  check("path traversal in repo path: refused", b.status === 1 && /repository not found|invalid/.test(b.stderr), b.stderr.trim());
  b = await bad("git-upload-pack 'comcom/.aindrive/config.json'");
  check("reserved .aindrive path: refused", b.status === 1 && /permission denied|not found/.test(b.stderr), b.stderr.trim());
  b = await bad("git-upload-pack 'nosuchorg/repo'");
  check("unknown org slug: 'repository not found'", b.status === 1 && /repository not found/.test(b.stderr), b.stderr.trim());
  b = await run("ssh", [...sshCmd(K.owner).split(" ").slice(1), "-T", "git@127.0.0.1"], { timeout: 30_000, input: "" });
  check("interactive shell request: no shell", b.status !== 0, (b.stderr || b.stdout).trim().slice(0, 200));

  console.log(`[harness] SSO lookups made: ${lookups} (cache ≤60s makes the ssh probe+sign rounds one lookup per key)`);
} finally {
  const failed = results.filter((x) => !x.ok);
  console.log(`\n[harness] ${results.length - failed.length}/${results.length} checks passed${failed.length ? " — FAILED: " + failed.map((f) => f.name).join("; ") : ""}`);
  agent.kill("SIGTERM");
  sshServer.close();
  wss.close(); http.close();
  setTimeout(() => process.exit(failed.length ? 1 : 0), 500);
}
