#!/usr/bin/env node
// Turn a legacy drive repo (one non-bare directory with receive.denyCurrentBranch=updateInstead,
// what `git-init` made before 2026-10) into the current layout (cli/src/rpc.js, web/lib/git-paths.ts):
//
//   repositories/<repo>.git   bare remote (every clone/push targets it; http.receivepack=true)
//   repositories/<repo>/      working copy — the SAME directory as before, untouched: history,
//                             working tree and uncommitted edits all stay; only `origin` changes
//
// Run it ON THE MACHINE THAT HOLDS THE DRIVE (where the aindrive agent runs), with the agent
// stopped or idle, as the user that owns the files:
//
//   node scripts/migrate-repo-layout.mjs <drive root> <repo name> [--dry-run]
//   node scripts/migrate-repo-layout.mjs /Volumes/comcom clef-artwork-search
//
// The repo may be at repositories/<repo> (preferred) or at the drive root (<repo>); a root repo is
// moved under repositories/ first (git tracks nothing by absolute path, so a move is safe).
// Idempotent: a repo that already has its bare sibling is left alone. Nothing is deleted.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";

const [, , rootArg, repoArg, ...flags] = process.argv;
if (!rootArg || !repoArg) {
  console.error("usage: migrate-repo-layout.mjs <drive root> <repo name> [--dry-run]");
  process.exit(2);
}
const dry = flags.includes("--dry-run");
const root = path.resolve(rootArg);
const name = repoArg.replace(/\.git$/, "");
const reposDir = path.join(root, "repositories");
const wc = path.join(reposDir, name);
const bare = path.join(reposDir, name + ".git");
const legacyAtRoot = path.join(root, name);

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "inherit"] }).toString().trim();
const step = (what, fn) => { console.log((dry ? "[dry-run] " : "") + what); if (!dry) fn(); };

if (existsSync(path.join(bare, "HEAD"))) { console.log(`${bare} exists — already migrated, nothing to do`); process.exit(0); }
if (!existsSync(path.join(wc, ".git")) && existsSync(path.join(legacyAtRoot, ".git"))) {
  step(`move ${legacyAtRoot} → ${wc}`, () => { mkdirSync(reposDir, { recursive: true }); renameSync(legacyAtRoot, wc); });
}
const wcNow = dry && !existsSync(path.join(wc, ".git")) ? legacyAtRoot : wc;
if (!existsSync(path.join(wcNow, ".git"))) { console.error(`no repository at ${wc} (or ${legacyAtRoot})`); process.exit(1); }

const branch = git(wcNow, "symbolic-ref", "--short", "-q", "HEAD") || "main";
console.log(`working copy: ${wcNow} (branch ${branch}, ${git(wcNow, "status", "--porcelain").split("\n").filter(Boolean).length} uncommitted change(s) — kept)`);

step(`create the bare remote ${bare} from the working copy's history`, () => {
  // --bare clone keeps every branch and tag; the working tree stays where it is.
  git(reposDir, "clone", "-q", "--bare", "--no-hardlinks", wc, bare);
  git(bare, "config", "http.receivepack", "true");
  git(bare, "symbolic-ref", "HEAD", "refs/heads/" + branch);
});
step(`point the working copy's origin at ../${name}.git and track origin/${branch}`, () => {
  if (git(wc, "remote").split("\n").includes("origin")) git(wc, "remote", "remove", "origin");
  git(wc, "remote", "add", "origin", "../" + name + ".git");
  git(wc, "fetch", "-q", "origin");
  git(wc, "branch", "-q", "--set-upstream-to=origin/" + branch, branch);
  // the old push target is gone, so the old receive hooks are moot
  try { git(wc, "config", "--unset", "receive.denyCurrentBranch"); } catch { /* unset already */ }
  try { git(wc, "config", "--unset", "http.receivepack"); } catch { /* unset already */ }
});
console.log(dry ? "dry run complete — nothing changed" : `done: clone/push ${name} now target ${bare}; the drive shows ${wc}`);
