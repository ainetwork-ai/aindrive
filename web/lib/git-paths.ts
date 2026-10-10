// Where a repo lives in a drive (pure; mirrored by the agent's layout note in
// cli/src/rpc.js). One repo is TWO folders under `repositories/`:
//
//   repositories/<repo>.git   bare remote — every clone/push (HTTP, SSH) targets it
//   repositories/<repo>/      working copy (origin = ../<repo>.git) — what the drive
//                             shows and edits, what ▶ Run executes, what the panel commits
//
// In web code a repo is named by its WORKING COPY path (`repositories/<repo>`):
// that is the folder the user sees, the path roles are granted on, the key of
// git_project_hooks, and what the pretty URL `/<org>/git/<repo>` means. The
// bare is derived (`bareOf`) only where the agent runs git's transport.
// A legacy repo (non-bare, no `.git` sibling; the 2026-10 updateInstead layout)
// is still read; scripts/migrate-repo-layout.mjs turns it into this layout.
export const GIT_REPOS_DIR = "repositories";

const stripGit = (s: string) => (s.endsWith(".git") && s.length > 4 ? s.slice(0, -4) : s);

/** `/<org>/git/<name>` → the working copy `repositories/<name>` (a `.git` suffix on the name is dropped). */
export function workingCopyPath(name: string): string {
  // `/<org>/git/repositories/<name>` (URLs minted before the folder was implied) means the same repo.
  const bare = name.startsWith(`${GIT_REPOS_DIR}/`) ? name.slice(GIT_REPOS_DIR.length + 1) : name;
  return `${GIT_REPOS_DIR}/${stripGit(bare)}`;
}

/** The bare remote for a working copy path (`repositories/x` → `repositories/x.git`; already bare → itself). */
export function bareOf(repoPath: string): string {
  return repoPath.endsWith(".git") ? repoPath : `${repoPath}.git`;
}

/** The working copy for a bare path (`repositories/x.git` → `repositories/x`; not bare → itself). */
export function workingCopyOf(repoPath: string): string {
  return stripGit(repoPath);
}

/** The repo name a pretty URL carries for this working copy, or null when it is not directly under `repositories/`. */
export function repoNameOf(repoPath: string): string | null {
  const wc = workingCopyOf(repoPath);
  const m = new RegExp(`^${GIT_REPOS_DIR}/([^/]+)$`).exec(wc);
  return m ? m[1] : null;
}
