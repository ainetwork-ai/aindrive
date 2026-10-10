import { getUser } from "@/lib/session";
import { resolveGitSite, serveGitRaw } from "@/lib/git-site";

/**
 * `/<org>/git/<repo>/raw/<ref>/<file path>` opened in a browser (rewritten here
 * by next.config.ts): the file's bytes at that ref. A non-browser client (curl,
 * no text/html Accept) reaches the same bytes through app/[slug]/git/[...path].
 */
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string; repo: string; rest: string[] }> }) {
  const { slug, repo, rest } = await params;
  const user = await getUser();
  const site = await resolveGitSite(slug, [repo, "raw", ...rest], user?.id ?? null);
  if (site.kind === "not_found") return new Response("not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  if (site.kind === "denied") return new Response("forbidden\n", { status: site.status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  if (site.kind === "offline") return new Response("the drive's agent is offline\n", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return serveGitRaw(site);
}
