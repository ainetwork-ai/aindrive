import { listDriveOrgShares } from "./orgs.js";
import { resolveGitSlug } from "./git-slug";

/**
 * The URL to clone a repo folder from (server only; shown with a copy button
 * in the web git panel). The friendly `/<org-slug>/git/<repo>` form when the
 * drive is shared with an org whose slug resolves back to this very drive
 * (lib/git-slug.ts rule — otherwise that URL would 404 or name another drive);
 * else the always-valid `/api/drives/<id>/git/<repo>` form.
 */
export function gitCloneUrl(origin: string, driveId: string, repo: string): string {
  const base = origin.replace(/\/$/, "");
  const slug = orgSlugForDrive(driveId);
  // Repos live under the drive's `repositories/` folder, but the pretty URL names only the repo
  // (the slug route adds the folder back); the drive-id form addresses the real path.
  const pretty = repo.replace(/^repositories\//, "");
  return slug ? `${base}/${slug}/git/${pretty}` : `${base}/api/drives/${driveId}/git/${repo}`;
}

function orgSlugForDrive(driveId: string): string | null {
  const shares = listDriveOrgShares(driveId) as Array<{ slug: string | null; inForce: boolean }>;
  for (const share of shares) {
    if (share.inForce && share.slug && resolveGitSlug(share.slug) === driveId) return share.slug;
  }
  return null;
}
