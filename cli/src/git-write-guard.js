// Diagnostics for writes into a git working tree.
//
// A web editor's autosave once rewrote files that `git push` (non-bare repo,
// receive.denyCurrentBranch=updateInstead) had just updated, and the next push
// was refused for "unstaged changes". Nothing recorded WHO wrote the file. This
// module answers, for a `write` RPC: is `abs` inside a git working tree (a
// `.git` entry at an ancestor, not above the drive root), and would the bytes
// being written differ from HEAD's copy? Callers log the answer with the write's
// declared `source` (user-save / autosave / unknown). It never blocks a write.

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";

/** Nearest ancestor of `abs` (inclusive of its dir, bounded by `root`) holding a `.git` entry, or null. */
export function findGitWorkTree(root, abs, fsx = { existsSync }) {
  let dir = path.dirname(abs);
  const stop = path.resolve(root);
  for (;;) {
    if (fsx.existsSync(path.join(dir, ".git"))) return dir;
    if (dir === stop || dir === path.dirname(dir)) return null;
    dir = path.dirname(dir);
  }
}

/** Bytes of `rel` at HEAD, or null when untracked / no commits / git missing. */
export function readHeadBlob(workTree, rel) {
  return new Promise((resolve) => {
    const spec = `HEAD:${rel.split(path.sep).join("/")}`;
    execFile("git", ["-C", workTree, "show", spec], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/**
 * Describe a pending write for the log: { workTree, rel, tracked, differsFromHead }
 * or null when `abs` is not inside a git working tree. Never throws.
 */
export async function describeGitWrite(root, abs, data, deps = {}) {
  try {
    const workTree = (deps.findGitWorkTree ?? findGitWorkTree)(root, abs);
    if (!workTree) return null;
    const rel = path.relative(workTree, abs);
    const head = await (deps.readHeadBlob ?? readHeadBlob)(workTree, rel);
    if (head === null) return { workTree, rel, tracked: false, differsFromHead: true };
    return { workTree, rel, tracked: true, differsFromHead: !head.equals(data) };
  } catch {
    return null;
  }
}
