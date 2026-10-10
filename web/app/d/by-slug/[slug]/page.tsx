import { notFound } from "next/navigation";
import { resolveGitSlug } from "@/lib/git-slug";
import DrivePage from "../../[driveId]/page";

/**
 * The pretty repo URL, served in place: `https://<host>/<org>/git/<repo>` opened in a BROWSER is
 * rewritten here by next.config.ts (Accept: text/html only — git clients never send that and keep
 * hitting the smart-HTTP route). The URL in the address bar stays `/<org>/git/<repo>`; what renders
 * is the drive's folder view for that repo — the same DrivePage as /d/<driveId>?path=<repo>, with
 * the git panel (branch, commits, clone URL, Run, deployments). The org slug resolves to a drive
 * exactly like the git route does (lib/git-slug.ts); an unknown slug is a 404, not a hint.
 */
export default async function DriveBySlugPage({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ path?: string | string[] }>;
}) {
  const { slug } = await params;
  const driveId = resolveGitSlug(slug);
  if (!driveId) notFound();
  const sp = await searchParams;
  const raw = Array.isArray(sp.path) ? sp.path[0] : sp.path;
  const path = (raw ?? "").replace(/\.git$/, "");
  return DrivePage({ params: Promise.resolve({ driveId }), searchParams: Promise.resolve({ path }) });
}
