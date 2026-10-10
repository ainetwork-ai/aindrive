import { promises as fsp, existsSync, readdirSync, statSync, openSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import * as Y from "yjs";
import { appendUpdate, listEntries, statsForDoc, maybeCompact } from "./willow-store.js";
import { runAgentAsk } from "./agent-runner.js";
import { readHandoff } from "./handoffs.js";
import { describeGitWrite } from "./git-write-guard.js";
import { zipFolder, pruneStaleZips, ZipLimitError } from "./zip-folder.js";

import { log, trace as pinoTrace } from "./logger.js";

// Standard observability — stdout structured logs + optional POST to server's
// /api/dev/trace ring buffer. NO file writes.
let _serverUrl = null;
const _pending = [];
let _flushTimer = null;
export function setTraceServer(url) { _serverUrl = url; }

function flushSoon() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(async () => {
    _flushTimer = null;
    if (!_serverUrl || _pending.length === 0) { _pending.length = 0; return; }
    const batch = _pending.splice(0);
    try {
      const { request } = await import("undici");
      await request(new URL("/api/dev/trace", _serverUrl).toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batch),
      });
    } catch {}
  }, 250);
}

function cliTrace(_root, docId, event, extra = {}) {
  if (process.env.AINDRIVE_TRACE === "off") return;
  if (!docId) return;
  const evt = { t: Date.now(), src: "cli", docId, event, ...extra };
  try { pinoTrace.info(evt, evt.event); } catch {}
  _pending.push(evt);
  flushSoon();
}

function docIdFor(_root, relPath) {
  return createHash("sha1").update(relPath || "").digest("base64url").slice(0, 22);
}

export { cliTrace, docIdFor };

// Self-write suppression for fs.watch: agent.js consults this set to ignore
// changes that came from our own write RPC.
// Keyed by NFC: the write names the path as the server does (NFC), the watcher
// as the disk spells it (NFD for macOS-made names).
const _suppressedPaths = new Map(); // NFC path → expireMs
function _suppressFsChange(path, ttlMs = 2000) {
  _suppressedPaths.set(path.normalize("NFC"), Date.now() + ttlMs);
}
export function isSelfWrite(path) {
  const key = path.normalize("NFC");
  const exp = _suppressedPaths.get(key);
  if (!exp) return false;
  if (Date.now() > exp) { _suppressedPaths.delete(key); return false; }
  return true;
}

const RPC_METHODS = new Set([
  "list", "stat", "read", "write", "mkdir", "rename", "delete",
  "upload-chunk", "download-chunk", "thumbnail",
  // Folder download (web fs/download-folder): zip a folder to a temp file the web then
  // drains with download-chunk and deletes (zip-folder.js).
  "zip-folder",
  "yjs-write", "yjs-read", "yjs-stats",
  "agent-ask",
  // Mac app only: bytes of a file the owner handed to another agent (handoffs.js).
  "handoff-read",
  // Git smart-HTTP: real git over a repo in the drive FS (clone/push).
  "git-advertise", "git-init", "git-service",
  // Git panel in the web UI: what a repo folder shows (branch, HEAD, recent
  // commits, dirty count) and the one write it offers (commit everything).
  "git-meta", "git-commit",
  // GitHub-like repo pages (web/lib/git-urls.ts): read-only views of any ref —
  // branches, a tree, a file, the log, one commit with its diff.
  "git-refs", "git-ls-tree", "git-show", "git-log", "git-commit-detail",
  // Source control on the working copy (VS Code-like): changes, stage/unstage,
  // discard, push to the bare remote, fast-forward pull from it.
  "git-status", "git-stage", "git-discard", "git-push", "git-pull",
  // Git over SSH: the same two services as live bidirectional pipes (git-exec.js).
  "git-ssh-exec",
]);

/** The methods handleRpc answers, sorted (a copy: the set itself stays private). */
export function rpcMethodNames() {
  return [...RPC_METHODS].sort();
}

const HIDDEN = new Set([".aindrive", ".DS_Store", ".git"]);
const LIMITS = {
  maxPathBytes: 4096,
  maxReadBytes: 8 * 1024 * 1024,
  maxUploadChunkBytes: 4 * 1024 * 1024,
};

// Parts of `.aindrive/` the web server legitimately drives over RPC: agent
// JSON (web/src/infra/agent-repo) and upload temp parts (web fs/upload*).
// Everything else there — config.json (agentToken + driveSecret), agent.pid,
// willow.db, yjs/ — is refused, as defense in depth behind the web's own
// reserved-path gate. Mirrors web/shared/domain/policy/system-paths.ts.
const RPC_ALLOWED_SYSTEM_DIRS = [".aindrive/agents", ".aindrive/uploads"];
/** Where `zip-folder` may write (lower case: compared like isReservedRpcPath). */
const ZIP_TMP_DIR = ".aindrive/uploads/zip";

// Compared in lower case: on a case-insensitive filesystem (macOS)
// ".AINDRIVE/config.json" opens the same file.
export function isReservedRpcPath(rel) {
  const r = rel.toLowerCase();
  if (r !== ".aindrive" && !r.startsWith(".aindrive/")) return false;
  return !RPC_ALLOWED_SYSTEM_DIRS.some((d) => r === d || r.startsWith(d + "/"));
}

export function safeResolve(root, rel) {
  if (typeof rel !== "string") throw new Error("invalid path");
  if (Buffer.byteLength(rel, "utf8") > LIMITS.maxPathBytes) throw new Error("path too long");
  const joined = path.resolve(root, "." + path.sep + rel);
  if (joined !== root && !joined.startsWith(root + path.sep)) {
    throw new Error("path escapes drive root");
  }
  const onDisk = matchSpelling(root, joined);
  // Check the RESOLVED path so "./.aindrive//config.json" can't slip by.
  if (isReservedRpcPath(toRel(root, onDisk))) throw new Error("reserved path");
  return onDisk;
}

/**
 * The server names paths in NFC (web/lib/path.js). A file made by macOS tools
 * keeps its NFD bytes on a byte-exact filesystem (Linux ext4), where the NFC
 * name misses it — so each component that doesn't exist as spelled is matched
 * against its directory by NFC form. An exact match always wins; a component
 * with no match (a file about to be created) keeps the requested spelling.
 * APFS is normalization-insensitive, so on macOS the first lookup already hits.
 */
export function matchSpelling(root, abs, fsx = { existsSync, readdirSync }) {
  if (abs === root || fsx.existsSync(abs)) return abs;
  const rel = path.relative(root, abs);
  if (!/[^\x00-\x7f]/.test(rel)) return abs; // ASCII has one spelling — don't list folders for a missing name
  const parts = rel.split(path.sep);
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    const exact = path.join(cur, parts[i]);
    if (fsx.existsSync(exact)) { cur = exact; continue; }
    let names;
    try { names = fsx.readdirSync(cur); } catch { return path.join(cur, ...parts.slice(i)); }
    const want = parts[i].normalize("NFC");
    const hit = names.find((n) => n.normalize("NFC") === want);
    if (hit === undefined) return path.join(cur, ...parts.slice(i));
    cur = path.join(cur, hit);
  }
  return cur;
}

/**
 * Write `data` to `abs`, one write per file at a time in this agent. Two
 * overlapping `write` RPCs for one path used to run two `fs.writeFile`s at
 * once: each truncated and wrote through its own fd, leaving a file whose head
 * was one save and whose tail the other (plan 12.3). Chained here, each save
 * lands whole and the last one wins.
 *
 * In place on purpose, not temp + rename: Node's recursive fs.watch on Linux
 * watches each file's inode, so a file replaced by rename stops reporting
 * later edits made on the device (the editor's reload). A reader racing a write
 * can still see it half-written — web downloads catch that through
 * download-chunk's mtimeMs/size and end the stream instead.
 */
const _writeChains = new Map(); // abs path → tail of its write chain
export function writeFileSerialized(abs, data) {
  const prev = _writeChains.get(abs) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(() => fsp.writeFile(abs, data));
  const tail = run.catch(() => {});
  _writeChains.set(abs, tail);
  tail.then(() => { if (_writeChains.get(abs) === tail) _writeChains.delete(abs); });
  return run;
}

export function toRel(root, abs) {
  return path.relative(root, abs).split(path.sep).join("/");
}

export function guessMime(name) {
  const ext = path.extname(name).toLowerCase();
  const map = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
    ".js": "text/javascript", ".mjs": "text/javascript", ".ts": "text/typescript",
    ".tsx": "text/typescript", ".jsx": "text/javascript",
    ".html": "text/html", ".css": "text/css",
    ".py": "text/x-python", ".rs": "text/x-rust", ".go": "text/x-go",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  };
  return map[ext] || "application/octet-stream";
}

async function toEntry(root, abs) {
  const stat = await fsp.stat(abs);
  const name = path.basename(abs);
  return {
    name,
    path: toRel(root, abs),
    isDir: stat.isDirectory(),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    // When the file was created (0 where the filesystem does not record it): lets
    // the web tell a re-created file from the one an old reference named (plan task 10.2).
    birthtimeMs: stat.birthtimeMs || 0,
    ext: path.extname(name).slice(1).toLowerCase(),
    mime: stat.isDirectory() ? "folder" : guessMime(name),
  };
}

/**
 * sharp is loaded on the first thumbnail, not at start: the Mac app's bundled agent ships without it
 * (native, per-arch), and a missing module must fail that one request — the web route then pulls the
 * original — never stop the agent from connecting at all.
 */
let _sharp = null;
async function loadSharp() {
  if (!_sharp) _sharp = (await import("sharp")).default;
  return _sharp;
}

/**
 * Where `agent-ask` is answered when this agent runs inside the Mac app: the app's on-device agent,
 * reached over the utility process's parent port (desktop/src/main.js). Null = the CLI's own LLM agent.
 * @type {null | ((q: { root: string, query: string, agentId: string }) => Promise<{ answer: string, sources: unknown[], action?: unknown }>)}
 */
let askBridge = null;
export function setAskBridge(fn) { askBridge = fn; }

/**
 * The parent-port bridge itself: one message out, one reply back by id, a timeout so a busy
 * app never wedges the socket. Installed by the entry point when the app sets AINDRIVE_ASK_VIA_PARENT.
 */
export function parentPortAskBridge(port, timeoutMs = 60_000) {
  const pending = new Map();
  let seq = 0;
  port.on("message", (ev) => {
    const m = ev?.data ?? ev;
    const p = m?.type === "agent-ask" ? pending.get(m.id) : null;
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new Error(String(m.error))); else p.resolve(m.result);
  });
  port.start?.();
  return ({ root, query, agentId }) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("the Mac's agent did not answer in time")); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    port.postMessage({ type: "agent-ask", id, root, query, agentId });
  });
}

// ---- git smart-HTTP helpers (real git; we never hand-roll the pack protocol) ----
// Only these two services are ever spawned, and always with --stateless-rpc, so
// this is a scoped CGI host for git, nothing more.
function _gitService(v) { return v === "receive-pack" ? "receive-pack" : "upload-pack"; }
// A repo the agent can serve: bare (HEAD + objects at the path — repos created
// before non-bare pushes, still served) or non-bare (.git/ inside it, what
// `git-init` creates now). `git upload-pack <abs>` / `git receive-pack <abs>`
// find `.git` inside a non-bare path themselves.
function _isGitRepo(abs) {
  const bare = existsSync(path.join(abs, "HEAD")) && existsSync(path.join(abs, "objects"));
  const nonBare = existsSync(path.join(abs, ".git", "HEAD")) && existsSync(path.join(abs, ".git", "objects"));
  return bare || nonBare;
}
// ---- repo layout: bare remote + working copy ----
// A repo in a drive is TWO directories (owner's decision, 2026-10: the freely
// editable drive state and the pushed state must not be one directory):
//   <dir>/<repo>.git   the bare remote every clone/push targets (http.receivepack=true)
//   <dir>/<repo>/      the working copy — origin = ../<repo>.git — what the drive
//                      shows and edits, what ▶ Run executes, what the panel commits
// After a successful receive-pack into the bare (HTTP `git-service`, SSH
// git-exec.js), postReceive() fast-forwards the working copy — only when it is
// clean; a dirty copy is never touched, the panel shows it behind and offers
// Pull (ff-only) once it is clean. A repo's "push" from the panel is
// `git push origin HEAD` from the working copy into the bare (`git-push`),
// which runs the same postReceive — commit alone deploys nothing, exactly as on GitHub.
// Legacy: a non-bare repo with no `.git` sibling (made by the old updateInstead
// git-init) still serves clone/views; `git-meta` reports `layout: "legacy"`.
const _isBareName = (name) => name.endsWith(".git") && name.length > 4;
const _workingCopyOf = (bareAbs) => (_isBareName(path.basename(bareAbs)) ? bareAbs.slice(0, -".git".length) : null);
/** Does the working copy have changes `git status --porcelain` would list? */
async function _isDirty(wcAbs) {
  const st = await runGitCapture(["-C", wcAbs, "status", "--porcelain"]);
  if (st.code !== 0) throw new Error("git status failed: " + st.stderr.slice(0, 300));
  return st.stdout.toString().trim().length > 0;
}
async function _currentBranch(wcAbs) {
  const br = await runGitCapture(["-C", wcAbs, "symbolic-ref", "--short", "-q", "HEAD"]);
  return br.code === 0 ? br.stdout.toString().trim() : "";
}
/** ahead/behind of the working copy's branch vs origin/<branch>, after a (local, cheap) fetch. null = no remote branch yet. */
async function _aheadBehind(wcAbs, branch) {
  if (!branch) return null;
  await runGitCapture(["-C", wcAbs, "fetch", "-q", "origin"]);
  const r = await runGitCapture(["-C", wcAbs, "rev-list", "--left-right", "--count", `${branch}...origin/${branch}`]);
  if (r.code !== 0) return null;
  const [ahead, behind] = r.stdout.toString().trim().split(/\s+/).map((n) => Number(n) || 0);
  return { ahead, behind };
}
/**
 * After a push landed in the bare: fast-forward the working copy if it is clean.
 * Resolves to what happened (never throws — a push must not fail on this).
 */
export async function postReceive(bareAbs) {
  const wc = _workingCopyOf(bareAbs);
  if (!wc || !existsSync(path.join(wc, ".git"))) return { updated: false, reason: "no working copy" };
  try {
    if (await _isDirty(wc)) return { updated: false, reason: "working copy has changes" };
    let branch = await _currentBranch(wc);
    if (!branch) {
      // detached: nothing to fast-forward onto
      return { updated: false, reason: "detached HEAD" };
    }
    // Does the remote have that branch? (first push may create `main` while the unborn clone is on `main` too)
    const remote = await runGitCapture(["-C", bareAbs, "rev-parse", "--verify", "--quiet", "refs/heads/" + branch]);
    if (remote.code !== 0) {
      const head = await runGitCapture(["-C", bareAbs, "symbolic-ref", "--short", "-q", "HEAD"]);
      const remoteHead = head.code === 0 ? head.stdout.toString().trim() : "";
      const local = await runGitCapture(["-C", wc, "rev-parse", "--verify", "--quiet", "HEAD"]);
      // an unborn working copy follows whatever branch the bare's HEAD names (the first push decides)
      if (local.code !== 0 && remoteHead) {
        await runGitCapture(["-C", wc, "symbolic-ref", "HEAD", "refs/heads/" + remoteHead]);
        branch = remoteHead;
      } else return { updated: false, reason: "remote has no " + branch };
    }
    const pull = await runGitCapture(["-C", wc, "pull", "-q", "--ff-only", "origin", branch]);
    if (pull.code !== 0) return { updated: false, reason: "not a fast-forward: " + pull.stderr.slice(0, 200) };
    await runGitCapture(["-C", wc, "branch", "-q", "--set-upstream-to=origin/" + branch, branch]);
    return { updated: true, branch };
  } catch (e) {
    return { updated: false, reason: e.message };
  }
}
// Working-copy paths for stage/discard: repo-relative, no `..`, no absolute.
function _wcPaths(v) {
  const list = Array.isArray(v) ? v : [];
  if (list.length === 0 || list.length > 500) throw new Error("paths required");
  return list.map((p) => {
    const parts = String(p).split("/").filter((x) => x !== "");
    if (!parts.length || parts.some((x) => x === "." || x === "..") || String(p).startsWith("-")) throw new Error("invalid path");
    return parts.join("/");
  });
}
// `git status --porcelain=v2 -z --branch` → VS Code-like lists.
function parseStatusV2(buf) {
  const out = { staged: [], unstaged: [], untracked: [], branch: "", ahead: 0, behind: 0 };
  const recs = buf.toString().split("\0");
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (!rec) continue;
    if (rec.startsWith("# branch.head ")) { out.branch = rec.slice("# branch.head ".length); continue; }
    if (rec.startsWith("# branch.ab ")) { const m = /\+(\d+) -(\d+)/.exec(rec); if (m) { out.ahead = Number(m[1]); out.behind = Number(m[2]); } continue; }
    if (rec.startsWith("# ")) continue;
    const kind = rec[0];
    if (kind === "?") { out.untracked.push({ path: rec.slice(2), status: "U" }); continue; }
    if (kind === "!") continue;
    if (kind === "1" || kind === "2") {
      const f = rec.split(" ");
      const xy = f[1];
      // "2": rename/copy — the path is the 9th field, the original follows as the NEXT record
      const p = kind === "2" ? f.slice(9).join(" ") : f.slice(8).join(" ");
      if (kind === "2") i++;
      if (xy[0] !== ".") out.staged.push({ path: p, status: xy[0] });
      if (xy[1] !== ".") out.unstaged.push({ path: p, status: xy[1] });
      continue;
    }
    if (kind === "u") { const f = rec.split(" "); out.unstaged.push({ path: f.slice(10).join(" "), status: "C" }); }
  }
  return out;
}

// `%x1f` (unit separator) between fields: a subject can hold anything but a
// newline, so splitting on \x1f then \n is unambiguous.
const GIT_LOG_FORMAT = "%H%x1f%s%x1f%an%x1f%aI";
function parseGitLog(text) {
  return text.split("\n").filter(Boolean).map((line) => {
    const [sha, subject, author, date] = line.split("\x1f");
    return { sha, subject: subject ?? "", author: author ?? "", date: date ?? "" };
  });
}
function runGitCapture(args, stdinFd = "ignore") {
  return new Promise((resolve, reject) => {
    const p = spawn("git", args, { stdio: [stdinFd, "pipe", "pipe"] });
    const out = [], err = [];
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => err.push(d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }));
  });
}
function runGitToFile(args, stdinFd, stdoutFd) {
  return new Promise((resolve, reject) => {
    const p = spawn("git", args, { stdio: [stdinFd, stdoutFd, "pipe"] });
    const err = [];
    p.stderr.on("data", (d) => err.push(d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, stderr: Buffer.concat(err).toString() }));
  });
}


// ---- read-only views of a ref (web repo pages) ----
// A ref the pages may name: a branch, a tag or a sha — never an option (a
// leading `-` would reach git as a flag) and never a revision *expression*
// (`..`, `^`, `~`, `:` compose other revisions; the URL names one ref).
function _gitRef(v) {
  const ref = String(v ?? "HEAD").trim() || "HEAD";
  if (ref.startsWith("-") || /[\s~^:?*[\\]/.test(ref) || ref.includes("..") || ref.length > 256) throw new Error("invalid ref");
  return ref;
}
// A path inside the repo as git spells it (`a/b.txt`, "" = root). Not a
// filesystem path — git reads it from the object store — but the same shape
// rules keep it from naming anything outside the tree.
function _gitPath(v) {
  const parts = String(v ?? "").split("/").filter((x) => x !== "");
  if (parts.some((x) => x === "." || x === "..") || parts.join("/").length > LIMITS.maxPathBytes) throw new Error("invalid path");
  return parts.join("/");
}
async function _gitResolve(repo, ref) {
  const r = await runGitCapture(["-C", repo, "rev-parse", "--verify", "--quiet", "--end-of-options", ref + "^{commit}"]);
  if (r.code !== 0) throw new Error("unknown ref");
  return r.stdout.toString().trim();
}
const GIT_FULL_LOG_FORMAT = "%H%x1f%P%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%b%x1e";
function parseFullGitLog(text) {
  return text.split("\x1e").map((rec) => rec.replace(/^\n/, "")).filter(Boolean).map((rec) => {
    const [sha, parents, subject, author, authorEmail, date, body] = rec.split("\x1f");
    return { sha, parents: (parents ?? "").split(" ").filter(Boolean), subject: subject ?? "", author: author ?? "", authorEmail: authorEmail ?? "", date: date ?? "", body: (body ?? "").replace(/\n+$/, "") };
  });
}
const GIT_LS_MAX_LAST_COMMITS = 200;
const GIT_PATCH_MAX_BYTES = 512 * 1024;

/**
 * @param {object} params  the request's params (method + args, web/lib/protocol.ts)
 * @param {string} root    absolute drive root
 * @param {{ gitExecs?: import("./git-exec.js").GitExecs }} [ctx]
 *   connection-scoped state only agent.js has: `gitExecs` is the registry of
 *   live git-over-SSH pipes on this WebSocket (git-ssh-exec needs it).
 */
export async function handleRpc(params, root, ctx = {}) {
  if (!params || !RPC_METHODS.has(params.method)) throw new Error("unknown method");

  switch (params.method) {
    case "list": {
      const abs = safeResolve(root, params.path || "");
      const entries = await fsp.readdir(abs, { withFileTypes: true });
      const out = [];
      for (const e of entries) {
        if (HIDDEN.has(e.name)) continue;
        // A bare remote (`repositories/<repo>.git`, see git-init) is git's, not the user's: hidden like `.git`.
        if (e.isDirectory() && _isBareName(e.name)) continue;
        const full = path.join(abs, e.name);
        try { out.push(await toEntry(root, full)); } catch {}
      }
      out.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
      return { method: "list", entries: out };
    }
    case "stat": {
      const abs = safeResolve(root, params.path);
      try { return { method: "stat", entry: await toEntry(root, abs) }; }
      catch { return { method: "stat", entry: null }; }
    }
    case "read": {
      const abs = safeResolve(root, params.path);
      const st = await fsp.stat(abs);
      if (st.isDirectory()) throw new Error("is a directory");
      const maxBytes = Math.min(params.maxBytes ?? LIMITS.maxReadBytes, LIMITS.maxReadBytes);
      const fh = await fsp.open(abs, "r");
      try {
        const buf = Buffer.alloc(Math.min(st.size, maxBytes));
        await fh.read(buf, 0, buf.length, 0);
        const encoding = params.encoding === "base64" ? "base64" : "utf8";
        return { method: "read", content: buf.toString(encoding), encoding, truncated: st.size > buf.length };
      } finally { await fh.close(); }
    }
    case "write": {
      const abs = safeResolve(root, params.path);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      const encoding = params.encoding === "base64" ? "base64" : "utf8";
      const data = Buffer.from(params.content, encoding);
      // Who is writing: the editors declare "autosave" / "user-save"; anything
      // else (older clients, API callers) is "unknown". Diagnostic only.
      const source = typeof params.source === "string" ? params.source.slice(0, 32) : "unknown";
      // Suppress fs-changed for 2s after our own write so reload loop doesn't fire
      try { _suppressFsChange(params.path); } catch {}
      // Diagnostics (never blocks): a write inside a git working tree that
      // makes the file differ from HEAD is what turned a `git push` into
      // "Working directory has unstaged changes" — log it with its source so
      // the next incident names the writer.
      describeGitWrite(root, abs, data).then((g) => {
        if (g && g.differsFromHead) {
          log.warn({ path: params.path, source, workTree: g.workTree, tracked: g.tracked, byteLen: data.length }, "[write] file in a git working tree now differs from HEAD");
        }
      }).catch(() => {});
      await writeFileSerialized(abs, data);
      try { cliTrace(root, docIdFor(root, params.path), "disk-write", { extra: { path: params.path, byteLen: data.length, source } }); } catch {}
      return { method: "write", ok: true, bytes: data.length };
    }
    case "mkdir": {
      const abs = safeResolve(root, params.path);
      await fsp.mkdir(abs, { recursive: true });
      return { method: "mkdir", ok: true };
    }
    case "rename": {
      const from = safeResolve(root, params.from);
      const to = safeResolve(root, params.to);
      if (from === root) throw new Error("cannot rename root");
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.rename(from, to);
      return { method: "rename", ok: true };
    }
    case "delete": {
      const abs = safeResolve(root, params.path);
      if (abs === root) throw new Error("cannot delete root");
      await fsp.rm(abs, { recursive: true, force: true });
      return { method: "delete", ok: true };
    }
    case "upload-chunk": {
      const abs = safeResolve(root, params.path);
      const buf = Buffer.from(params.data, "base64");
      if (buf.length > LIMITS.maxUploadChunkBytes) throw new Error("chunk too large");
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      const fh = await fsp.open(abs, params.chunkId === 0 ? "w" : "a");
      try { await fh.write(buf); }
      finally { await fh.close(); }
      return { method: "upload-chunk", ok: true, receivedBytes: buf.length };
    }
    case "handoff-read": {
      // Not a path in this drive: a key the owner registered for one file (never `root`-relative).
      const r = await readHandoff(params.key, params.offset, params.length);
      return { method: "handoff-read", ...r };
    }
    case "download-chunk": {
      const abs = safeResolve(root, params.path);
      const fh = await fsp.open(abs, "r");
      try {
        const st = await fh.stat();
        const length = Math.min(params.length ?? LIMITS.maxUploadChunkBytes, LIMITS.maxUploadChunkBytes);
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, params.offset);
        const eof = params.offset + bytesRead >= st.size;
        // mtimeMs/size of the file this chunk came from: the web ends a stream
        // whose file was replaced mid-way instead of splicing two versions.
        return { method: "download-chunk", data: buf.subarray(0, bytesRead).toString("base64"), eof, mtimeMs: st.mtimeMs, size: st.size };
      } finally { await fh.close(); }
    }
    case "zip-folder": {
      // The folder is read with the same rules a listing applies (`.aindrive`, `.git`,
      // bare remotes hidden) plus `node_modules`; `exclude` names children the web
      // withholds from this caller (paid locks). `out` must be a temp path in the
      // zip upload dir — the web names it and deletes it after streaming.
      const abs = safeResolve(root, params.path || "");
      const st = await fsp.stat(abs);
      if (!st.isDirectory()) throw new Error("not a directory");
      const outAbs = safeResolve(root, params.out);
      const outRel = toRel(root, outAbs).toLowerCase();
      if (!outRel.startsWith(ZIP_TMP_DIR + "/") || !outRel.endsWith(".zip")) throw new Error("zip output must be under " + ZIP_TMP_DIR);
      const exclude = Array.isArray(params.exclude) ? params.exclude.filter((p) => typeof p === "string").slice(0, 10_000) : [];
      pruneStaleZips(path.join(root, ZIP_TMP_DIR)).catch(() => {});
      try {
        const r = await zipFolder(abs, outAbs, { exclude });
        return { method: "zip-folder", ok: true, ...r };
      } catch (e) {
        if (e instanceof ZipLimitError) throw e; // "zip limit: …" → the web answers 413
        throw new Error("zip failed: " + (e?.message || String(e)).slice(0, 200));
      }
    }
    case "thumbnail": {
      // Generate a small JPEG thumbnail for image files. Desktop doesn't have
      // system-cached thumbnails like mobile, so we decode + resize via sharp.
      // Still much faster than sending the full original: only this small JPEG
      // (usually ~20 KB) crosses the network.
      const abs = safeResolve(root, params.path);
      const px = params.px ?? 256;
      const jpeg = await (await loadSharp())(abs, { failOn: "none" })
        .rotate()
        .resize({ width: px, height: px, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
      return { method: "thumbnail", data: jpeg.toString("base64"), size: jpeg.length, mime: "image/jpeg" };
    }
    case "yjs-write": {
      const docId = String(params.docId || "");
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(docId)) throw new Error("invalid docId");
      const data = Buffer.from(params.data, "base64");
      if (data.length > 4 * LIMITS.maxUploadChunkBytes) throw new Error("yjs blob too large");
      // Append to Willow Store (each save = new entry, history preserved)
      const { seq, digest } = appendUpdate(root, docId, data);
      try { cliTrace(root, params.docId, "willow-append", { extra: { docId: params.docId, seq, digest, byteLen: data.length } }); } catch {}
      // Fire-and-forget compaction check — does not block the RPC response
      maybeCompact(root, docId).catch((e) => log.warn({ err: e.message }, "[yjs-write] maybeCompact error"));
      // Also write the latest snapshot as a single .bin for fast cold-start reads
      const yjsDir = path.join(root, ".aindrive", "yjs");
      await fsp.mkdir(yjsDir, { recursive: true });
      await fsp.writeFile(path.join(yjsDir, `${docId}.bin`), data);
      return { method: "yjs-write", ok: true, bytes: data.length, seq, digest };
    }
    case "yjs-read": {
      const docId = String(params.docId || "");
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(docId)) throw new Error("invalid docId");
      // Prefer Willow Store entries (replay all updates → single state)
      try {
        const entries = listEntries(root, docId);
        if (entries.length > 0) {
          const doc = new Y.Doc();
          for (const e of entries) {
            try { Y.applyUpdate(doc, new Uint8Array(e.payload)); } catch {}
          }
          const merged = Y.encodeStateAsUpdate(doc);
          try { cliTrace(root, params.docId, "willow-replay", { extra: { docId: params.docId, entries: entries.length, finalByteLen: merged.length } }); } catch {}
          return { method: "yjs-read", data: Buffer.from(merged).toString("base64"), bytes: merged.length };
        }
      } catch (e) { log.warn({ err: e.message }, "[yjs-read] willow replay failed"); }
      // Fallback: legacy .bin snapshot
      const target = path.join(root, ".aindrive", "yjs", `${docId}.bin`);
      try {
        const buf = await fsp.readFile(target);
        return { method: "yjs-read", data: buf.toString("base64"), bytes: buf.length };
      } catch (e) {
        if (e.code === "ENOENT") return { method: "yjs-read", data: "", bytes: 0 };
        throw e;
      }
    }
    case "yjs-stats": {
      const docId = String(params.docId || "");
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(docId)) throw new Error("invalid docId");
      return { method: "yjs-stats", ...statsForDoc(root, docId) };
    }
    case "agent-ask": {
      // Web side has already verified caller identity + access policy.
      // Here we trust the RPC and run the agent locally — that's how
      // llm.apiKey stays on the owner's machine.
      const agentId = String(params.agentId || "");
      const query = String(params.query || "");
      // Inside the Mac app the folder's questions go to its on-device agent (no API key needed);
      // the plain CLI keeps the LLM agent in .aindrive/agents.
      const result = askBridge ? await askBridge({ root, query, agentId }) : await runAgentAsk({ root, agentId, query });
      return { method: "agent-ask", ...result };
    }
    case "git-init": {
      // A new repo = the bare remote `<repo>.git` AND its working copy `<repo>/`
      // (layout note above). `repo` names the bare: it must end in `.git`; a
      // name without it (an old caller) is given the suffix. The working copy
      // is an empty clone until the first push lands and postReceive fills it.
      const given = String(params.repo ?? "");
      const bareRel = _isBareName(path.basename(given)) ? given : given + ".git";
      const bare = safeResolve(root, bareRel);
      const wc = _workingCopyOf(bare);
      if (existsSync(bare)) throw new Error("repository exists");
      if (existsSync(path.join(wc, ".git"))) throw new Error("a working copy already exists there — migrate it (scripts/migrate-repo-layout.mjs)");
      await fsp.mkdir(path.dirname(bare), { recursive: true });
      const r = await runGitCapture(["init", "-q", "--bare", "--initial-branch=main", bare]);
      if (r.code !== 0) throw new Error("git init failed: " + r.stderr.slice(0, 300));
      const c = await runGitCapture(["-C", bare, "config", "http.receivepack", "true"]);
      if (c.code !== 0) throw new Error("git config failed: " + c.stderr.slice(0, 300));
      const cl = await runGitCapture(["clone", "-q", "--no-hardlinks", bare, wc]);
      if (cl.code !== 0) throw new Error("git clone failed: " + cl.stderr.slice(0, 300));
      // origin as a RELATIVE path, so the drive folder can move (or sync to another machine) intact
      await runGitCapture(["-C", wc, "remote", "set-url", "origin", "../" + path.basename(bare)]);
      await runGitCapture(["-C", wc, "symbolic-ref", "HEAD", "refs/heads/main"]);
      return { method: "git-init", ok: true, bare: bareRel, workingCopy: bareRel.slice(0, -".git".length) };
    }
    case "git-advertise": {
      const repo = safeResolve(root, params.repo);
      const service = _gitService(params.service);
      if (!_isGitRepo(repo)) return { method: "git-advertise", exists: false, data: "" };
      const r = await runGitCapture([service, "--stateless-rpc", "--advertise-refs", repo]);
      if (r.code !== 0) throw new Error("git " + service + " advertise failed: " + r.stderr.slice(0, 300));
      return { method: "git-advertise", exists: true, data: r.stdout.toString("base64") };
    }
    case "git-service": {
      const repo = safeResolve(root, params.repo);
      const service = _gitService(params.service);
      if (!_isGitRepo(repo)) throw new Error("not a git repository");
      const inAbs = safeResolve(root, params.in);
      const outAbs = safeResolve(root, params.out);
      await fsp.mkdir(path.dirname(outAbs), { recursive: true });
      const inFd = openSync(inAbs, "r");
      const outFd = openSync(outAbs, "w");
      try {
        const r = await runGitToFile([service, "--stateless-rpc", repo], inFd, outFd);
        if (r.code !== 0) throw new Error("git " + service + " failed: " + r.stderr.slice(0, 300));
      } finally { try { closeSync(inFd); } catch {} try { closeSync(outFd); } catch {} }
      // A push landed: bring a clean working copy up to date (never a dirty one).
      const sync = service === "receive-pack" ? await postReceive(repo) : undefined;
      return { method: "git-service", ok: true, size: statSync(outAbs).size, ...(sync ? { workingCopy: sync } : {}) };
    }
    case "git-meta": {
      // Read-only summary for the web git panel. An unborn branch (fresh
      // git-init, nothing pushed yet) has no HEAD commit: log fails, so the
      // branch comes from symbolic-ref and commits stay empty.
      const repo = safeResolve(root, params.repo);
      if (!_isGitRepo(repo)) return { method: "git-meta", exists: false };
      const br = await runGitCapture(["-C", repo, "symbolic-ref", "--short", "-q", "HEAD"]);
      let branch = br.code === 0 ? br.stdout.toString().trim() : "";
      if (!branch) {
        const det = await runGitCapture(["-C", repo, "rev-parse", "--short", "HEAD"]);
        branch = det.code === 0 ? "detached@" + det.stdout.toString().trim() : "HEAD";
      }
      const log = await runGitCapture(["-C", repo, "log", "-n", "10", "--format=" + GIT_LOG_FORMAT]);
      const commits = log.code === 0 ? parseGitLog(log.stdout.toString()) : [];
      const st = await runGitCapture(["-C", repo, "status", "--porcelain"]);
      const dirty = st.code === 0 ? st.stdout.toString().split("\n").filter(Boolean).length : 0;
      // Layout: a working copy whose `origin` is the bare sibling, or a legacy non-bare repo (no sibling).
      const isWc = existsSync(path.join(repo, ".git"));
      const hasBare = isWc && existsSync(path.join(repo + ".git", "HEAD"));
      const layout = !isWc ? "bare" : hasBare ? "working-copy" : "legacy";
      const ab = layout === "working-copy" ? await _aheadBehind(repo, br.code === 0 ? branch : "") : null;
      return { method: "git-meta", exists: true, branch, head: commits[0] ?? null, dirty, commits, layout, ahead: ab?.ahead ?? 0, behind: ab?.behind ?? 0 };
    }
    case "git-commit": {
      // Commit everything in the working tree as the signed-in web user. The
      // identity comes per-invocation (-c), never written into the repo config.
      const repo = safeResolve(root, params.repo);
      if (!_isGitRepo(repo)) throw new Error("not a git repository");
      if (!existsSync(path.join(repo, ".git"))) throw new Error("bare repository has no working tree");
      const message = String(params.message ?? "").trim();
      if (!message) throw new Error("commit message required");
      const authorName = String(params.authorName || "").trim() || "aindrive";
      const authorEmail = String(params.authorEmail || "").trim() || "noreply@aindrive.ainetwork.ai";
      if (/[\r\n]/.test(authorName + authorEmail)) throw new Error("invalid author");
      // `all` (the panel's "stage all & commit", VS Code's default): stage everything first.
      // Otherwise only what is staged is committed; nothing staged = nothing to commit.
      if (params.all !== false) {
        const add = await runGitCapture(["-C", repo, "add", "-A"]);
        if (add.code !== 0) throw new Error("git add failed: " + add.stderr.slice(0, 300));
      }
      const st = await runGitCapture(["-C", repo, "status", "--porcelain"]);
      if (st.code !== 0) throw new Error("git status failed: " + st.stderr.slice(0, 300));
      if (!st.stdout.toString().trim()) throw new Error("nothing to commit");
      const staged = await runGitCapture(["-C", repo, "diff", "--cached", "--quiet"]);
      const unborn = (await runGitCapture(["-C", repo, "rev-parse", "--verify", "--quiet", "HEAD"])).code !== 0;
      if (staged.code === 0 && !unborn) throw new Error("nothing staged — stage changes first, or commit all");
      const c = await runGitCapture([
        "-C", repo, "-c", "user.name=" + authorName, "-c", "user.email=" + authorEmail,
        "commit", "-q", "-m", message,
      ]);
      if (c.code !== 0) throw new Error("git commit failed: " + c.stderr.slice(0, 300));
      const head = await runGitCapture(["-C", repo, "rev-parse", "HEAD"]);
      if (head.code !== 0) throw new Error("git rev-parse failed: " + head.stderr.slice(0, 300));
      return { method: "git-commit", sha: head.stdout.toString().trim() };
    }
    case "git-refs": {
      // Branches + the checked-out one (what the repo pages call the default
      // branch). An unborn HEAD (fresh git-init) has a name but no sha.
      const repo = safeResolve(root, params.repo);
      if (!_isGitRepo(repo)) return { method: "git-refs", exists: false };
      const br = await runGitCapture(["-C", repo, "symbolic-ref", "--short", "-q", "HEAD"]);
      const head = br.code === 0 ? br.stdout.toString().trim() : "";
      const sha = await runGitCapture(["-C", repo, "rev-parse", "--verify", "--quiet", "HEAD"]);
      const ls = await runGitCapture(["-C", repo, "for-each-ref", "--format=%(refname:short)%1f%(objectname)", "refs/heads/"]);
      const branches = ls.code === 0
        ? ls.stdout.toString().split("\n").filter(Boolean).map((l) => { const [name, s] = l.split("\x1f"); return { name, sha: s ?? "" }; })
        : [];
      return { method: "git-refs", exists: true, head: head || (sha.code === 0 ? "detached@" + sha.stdout.toString().trim().slice(0, 7) : "HEAD"), headSha: sha.code === 0 ? sha.stdout.toString().trim() : null, branches };
    }
    case "git-ls-tree": {
      // One folder of the tree at a ref, with each entry's last commit (one
      // `git log -1` per entry, so a huge folder lists without them).
      const repo = safeResolve(root, params.repo);
      if (!_isGitRepo(repo)) throw new Error("not a git repository");
      const ref = _gitRef(params.ref);
      const dir = _gitPath(params.path);
      const sha = await _gitResolve(repo, ref);
      const spec = dir ? sha + ":" + dir : sha;
      const ls = await runGitCapture(["-C", repo, "ls-tree", "-l", "-z", spec]);
      if (ls.code !== 0) throw new Error(/not a tree|does not exist|not a valid object name|exists on disk, but not in/i.test(ls.stderr) ? "no such path at ref" : "git ls-tree failed: " + ls.stderr.slice(0, 300));
      const entries = ls.stdout.toString().split("\0").filter(Boolean).map((line) => {
        // "<mode> <type> <sha> <size>\t<name>"
        const tab = line.indexOf("\t");
        const [mode, type, , size] = line.slice(0, tab).split(/\s+/);
        const name = line.slice(tab + 1);
        return { name, type: type === "tree" ? "tree" : type === "commit" ? "commit" : "blob", mode, size: size === "-" ? 0 : Number(size) || 0 };
      });
      if (entries.length <= GIT_LS_MAX_LAST_COMMITS) {
        for (const e of entries) {
          const p = dir ? dir + "/" + e.name : e.name;
          const l = await runGitCapture(["-C", repo, "log", "-n", "1", "--format=" + GIT_LOG_FORMAT, sha, "--", p]);
          if (l.code === 0) e.lastCommit = parseGitLog(l.stdout.toString())[0] ?? null;
        }
      }
      entries.sort((a, b) => (a.type !== b.type ? (a.type === "tree" ? -1 : b.type === "tree" ? 1 : 0) : a.name.localeCompare(b.name)));
      return { method: "git-ls-tree", sha, entries };
    }
    case "git-show": {
      // A file's bytes at a ref, base64, capped like `read`.
      const repo = safeResolve(root, params.repo);
      if (!_isGitRepo(repo)) throw new Error("not a git repository");
      const ref = _gitRef(params.ref);
      const file = _gitPath(params.path);
      if (!file) throw new Error("path required");
      const sha = await _gitResolve(repo, ref);
      const kind = await runGitCapture(["-C", repo, "cat-file", "-t", sha + ":" + file]);
      if (kind.code !== 0) throw new Error("no such path at ref");
      if (kind.stdout.toString().trim() !== "blob") throw new Error("is a directory");
      const sz = await runGitCapture(["-C", repo, "cat-file", "-s", sha + ":" + file]);
      const size = Number(sz.stdout.toString().trim()) || 0;
      const maxBytes = Math.min(params.maxBytes ?? LIMITS.maxReadBytes, LIMITS.maxReadBytes);
      const r = await runGitCapture(["-C", repo, "cat-file", "blob", sha + ":" + file]);
      if (r.code !== 0) throw new Error("git cat-file failed: " + r.stderr.slice(0, 300));
      const truncated = r.stdout.length > maxBytes;
      return { method: "git-show", sha, size, content: (truncated ? r.stdout.subarray(0, maxBytes) : r.stdout).toString("base64"), truncated };
    }
    case "git-log": {
      const repo = safeResolve(root, params.repo);
      if (!_isGitRepo(repo)) throw new Error("not a git repository");
      const ref = _gitRef(params.ref);
      const p = _gitPath(params.path);
      const n = Math.max(1, Math.min(Number(params.n) || 50, 200));
      const sha = await _gitResolve(repo, ref);
      const args = ["-C", repo, "log", "-n", String(n), "--format=" + GIT_FULL_LOG_FORMAT, sha];
      if (p) args.push("--", p);
      const l = await runGitCapture(args);
      if (l.code !== 0) throw new Error("git log failed: " + l.stderr.slice(0, 300));
      return { method: "git-log", sha, commits: parseFullGitLog(l.stdout.toString()) };
    }
    case "git-commit-detail": {
      // Message, author, changed files with +/−, and the patch (capped).
      const repo = safeResolve(root, params.repo);
      if (!_isGitRepo(repo)) throw new Error("not a git repository");
      const sha = await _gitResolve(repo, _gitRef(params.sha));
      const meta = await runGitCapture(["-C", repo, "log", "-n", "1", "--format=" + GIT_FULL_LOG_FORMAT, sha]);
      if (meta.code !== 0) throw new Error("git log failed: " + meta.stderr.slice(0, 300));
      const commit = parseFullGitLog(meta.stdout.toString())[0];
      // --root: a first commit diffs against the empty tree. -m keeps a merge to its first parent.
      const stat = await runGitCapture(["-C", repo, "show", "--format=", "--numstat", "--root", "--first-parent", "-m", sha]);
      const files = stat.code === 0 ? stat.stdout.toString().split("\n").filter(Boolean).map((line) => {
        const [a, d, ...rest] = line.split("\t");
        return { path: rest.join("\t"), additions: a === "-" ? null : Number(a), deletions: d === "-" ? null : Number(d) };
      }) : [];
      const diff = await runGitCapture(["-C", repo, "show", "--format=", "--patch", "--root", "--first-parent", "-m", "--no-color", sha]);
      const patchBuf = diff.code === 0 ? diff.stdout : Buffer.alloc(0);
      const truncated = patchBuf.length > GIT_PATCH_MAX_BYTES;
      return { method: "git-commit-detail", ...commit, files, patch: (truncated ? patchBuf.subarray(0, GIT_PATCH_MAX_BYTES) : patchBuf).toString("utf8"), truncated };
    }
    case "git-status": {
      // VS Code-like source control state of the working copy.
      const repo = safeResolve(root, params.repo);
      if (!_isGitRepo(repo) || !existsSync(path.join(repo, ".git"))) throw new Error("not a git repository");
      const st = await runGitCapture(["-C", repo, "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]);
      if (st.code !== 0) throw new Error("git status failed: " + st.stderr.slice(0, 300));
      const parsed = parseStatusV2(st.stdout);
      const hasBare = existsSync(path.join(repo + ".git", "HEAD"));
      const ab = hasBare ? await _aheadBehind(repo, parsed.branch && parsed.branch !== "(detached)" ? parsed.branch : "") : null;
      return { method: "git-status", ...parsed, ahead: ab?.ahead ?? parsed.ahead, behind: ab?.behind ?? parsed.behind, hasRemote: hasBare };
    }
    case "git-stage": {
      const repo = safeResolve(root, params.repo);
      if (!_isGitRepo(repo) || !existsSync(path.join(repo, ".git"))) throw new Error("not a git repository");
      const paths = _wcPaths(params.paths);
      const r = params.unstage
        ? await runGitCapture(["-C", repo, "reset", "-q", "--", ...paths])
        : await runGitCapture(["-C", repo, "add", "-A", "--", ...paths]);
      if (r.code !== 0) throw new Error("git " + (params.unstage ? "reset" : "add") + " failed: " + r.stderr.slice(0, 300));
      return { method: "git-stage", ok: true };
    }
    case "git-discard": {
      // Throw away working-tree changes to these paths: tracked → back to the index/HEAD, untracked → removed.
      const repo = safeResolve(root, params.repo);
      if (!_isGitRepo(repo) || !existsSync(path.join(repo, ".git"))) throw new Error("not a git repository");
      const paths = _wcPaths(params.paths);
      const tracked = [], untracked = [];
      for (const p of paths) {
        const ls = await runGitCapture(["-C", repo, "ls-files", "--error-unmatch", "--", p]);
        (ls.code === 0 ? tracked : untracked).push(p);
      }
      if (tracked.length) {
        const r = await runGitCapture(["-C", repo, "checkout", "-q", "--", ...tracked]);
        if (r.code !== 0) throw new Error("git checkout failed: " + r.stderr.slice(0, 300));
      }
      if (untracked.length) {
        const r = await runGitCapture(["-C", repo, "clean", "-q", "-f", "-d", "--", ...untracked]);
        if (r.code !== 0) throw new Error("git clean failed: " + r.stderr.slice(0, 300));
      }
      return { method: "git-discard", ok: true, tracked: tracked.length, untracked: untracked.length };
    }
    case "git-push": {
      // The working copy's HEAD into the bare remote (= a push for deployment: the caller fires the hook).
      const repo = safeResolve(root, params.repo);
      if (!_isGitRepo(repo) || !existsSync(path.join(repo, ".git"))) throw new Error("not a git repository");
      if (!existsSync(path.join(repo + ".git", "HEAD"))) throw new Error("no remote: this repository has the legacy layout — migrate it (scripts/migrate-repo-layout.mjs)");
      const branch = await _currentBranch(repo);
      if (!branch) throw new Error("detached HEAD: check out a branch first");
      const before = await runGitCapture(["-C", repo + ".git", "rev-parse", "--verify", "--quiet", "refs/heads/" + branch]);
      const r = await runGitCapture(["-C", repo, "push", "-q", "origin", "HEAD:refs/heads/" + branch]);
      if (r.code !== 0) throw new Error("git push failed: " + r.stderr.slice(0, 300));
      await runGitCapture(["-C", repo, "branch", "-q", "--set-upstream-to=origin/" + branch, branch]);
      const after = await runGitCapture(["-C", repo, "rev-parse", "HEAD"]);
      return {
        method: "git-push", ok: true, ref: "refs/heads/" + branch,
        before: before.code === 0 ? before.stdout.toString().trim() : "0".repeat(40),
        after: after.stdout.toString().trim(),
      };
    }
    case "git-pull": {
      // Fast-forward the working copy from the bare; refused while it has changes.
      const repo = safeResolve(root, params.repo);
      if (!_isGitRepo(repo) || !existsSync(path.join(repo, ".git"))) throw new Error("not a git repository");
      if (!existsSync(path.join(repo + ".git", "HEAD"))) throw new Error("no remote: legacy layout");
      if (await _isDirty(repo)) throw new Error("working copy has changes — commit or discard them first");
      const sync = await postReceive(repo + ".git");
      if (!sync.updated) throw new Error("pull failed: " + sync.reason);
      const head = await runGitCapture(["-C", repo, "rev-parse", "HEAD"]);
      return { method: "git-pull", ok: true, sha: head.stdout.toString().trim() };
    }
    case "git-ssh-exec": {
      // Git over SSH (git-exec.js): spawn the service as a live pipe; the bytes
      // then travel as git-stdin / git-stdout frames on this same connection.
      // Same path guard and repo check as git-service; never creates a repo
      // (the server git-inits first, write-gated, exactly as for HTTP).
      if (!ctx.gitExecs) throw new Error("git-ssh-exec needs a streaming connection");
      const repo = safeResolve(root, params.repo);
      const service = _gitService(params.service);
      if (!_isGitRepo(repo)) throw new Error("not a git repository");
      // GIT_PROTOCOL is the only environment the client may set (git's own
      // `version=N` negotiation); anything else-shaped is dropped, not passed.
      const protocol = /^version=\d$/.test(String(params.protocol ?? "")) ? params.protocol : undefined;
      const { pid } = await ctx.gitExecs.start({ execId: params.execId, repoAbs: repo, service, protocol });
      return { method: "git-ssh-exec", ok: true, pid };
    }
  }
}
