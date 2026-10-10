import { listDriveOrgShares } from "./orgs.js";
import { resolveGitSlug } from "./git-slug";
import { repoNameOf } from "./git-paths";

/**
 * The URL to clone a repo from (server only; shown with a copy button in the
 * web git panel). `repo` is the working-copy path. The friendly
 * `/<org-slug>/git/<name>` form when the working copy is `repositories/<name>`
 * (lib/git-paths.ts) AND the drive is shared with an org whose slug resolves
 * back to this very drive (lib/git-slug.ts rule — otherwise that URL would 404
 * or name another drive); else the always-valid `/api/drives/<id>/git/<repo>` form.
 */
export function gitCloneUrl(origin: string, driveId: string, repo: string): string {
  const base = origin.replace(/\/$/, "");
  const name = repoNameOf(repo);
  const slug = name ? orgSlugForDrive(driveId) : null;
  return slug ? `${base}/${slug}/git/${name}` : `${base}/api/drives/${driveId}/git/${repo}`;
}

function orgSlugForDrive(driveId: string): string | null {
  const shares = listDriveOrgShares(driveId) as Array<{ slug: string | null; inForce: boolean }>;
  for (const share of shares) {
    if (share.inForce && share.slug && resolveGitSlug(share.slug) === driveId) return share.slug;
  }
  return null;
}
