import { NextResponse } from "next/server";
import { gitHttpGET, gitHttpPOST } from "@/lib/git-http";
import { resolveGitSlug } from "@/lib/git-slug";
import { getUser } from "@/lib/session";
import { parseGitUrlPath } from "@/lib/git-urls";
import { resolveGitSite, serveGitRaw } from "@/lib/git-site";
import { workingCopyPath } from "@/lib/git-paths";

/**
 * Friendly git smart-HTTP URL for a repo stored inside a drive:
 *   https://<host>/<org-slug>/git/<repo-path>[.git]
 *     e.g. git clone https://<host>/comcom/git/clef-artwork-search
 *
 * `<org-slug>` is an AIN SSO organization slug; lib/git-slug.ts turns it into
 * the drive shared with that organization (rule documented there). `<repo>` is
 * ONE name: the repo's working copy is the drive folder `repositories/<repo>`
 * and its bare remote `repositories/<repo>.git` (lib/git-paths.ts); the rest
 * (auth, upload/receive-pack, streaming) is the same lib/git-http.ts the
 * id-addressed /api/drives/<driveId>/git/… route uses, so access control runs
 * against the resolved drive and the working-copy path.
 *
 * An unresolvable slug answers 404 {"error":"not found"}, the same body as a
 * malformed git path, so the URL never reveals which drives exist.
 *
 * The same prefix is the repo's PAGES for a browser (lib/git-urls.ts): a request
 * with `text/html` in Accept is rewritten by next.config.ts to app/d/by-slug
 * before it reaches here. One page URL is served by this route as well:
 * `…/raw/<ref>/<file>` asked for by a non-browser client (curl, a script —
 * no text/html Accept) answers the file's bytes, like raw.githubusercontent.
 *
 * Routing: this folder only matches /<x>/git/<…>; Next gives static segments
 * priority, so /d/…, /docs/…, /api/… keep their own routes, and a reserved
 * name that happens to fall through (e.g. /docs/git/x) is refused by the
 * resolver. middleware.ts excludes /<slug>/git/ from its matcher so Next does
 * not buffer the pack body (10 MB cap) or touch the raw git responses.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ slug: string; path: string[] }> };

function notFound(): NextResponse {
  return NextResponse.json({ error: "not found" }, { status: 404 });
}

/** `[<repo>[.git], ...tail]` → the drive path segments git-http parses (`repositories/<repo>` + tail). */
function drivePath(path: string[]): string[] | null {
  if (path.length < 2 || !path[0] || path[0].startsWith(".")) return null;
  return [...workingCopyPath(path[0]).split("/"), ...path.slice(1)];
}

export async function GET(req: Request, { params }: Params) {
  const { slug, path } = await params;
  const driveId = resolveGitSlug(slug);
  if (!driveId) return notFound();
  if (parseGitUrlPath(path)?.view === "raw") {
    const user = await getUser();
    const site = await resolveGitSite(slug, path, user?.id ?? null);
    if (site.kind === "not_found") return notFound();
    if (site.kind === "denied") return NextResponse.json({ error: "forbidden" }, { status: site.status });
    if (site.kind === "offline") return NextResponse.json({ error: "drive offline" }, { status: 503 });
    return serveGitRaw(site);
  }
  const p = drivePath(path);
  return p ? gitHttpGET(driveId, p, req) : notFound();
}

export async function POST(req: Request, { params }: Params) {
  const { slug, path } = await params;
  const driveId = resolveGitSlug(slug);
  if (!driveId) return notFound();
  const p = drivePath(path);
  return p ? gitHttpPOST(driveId, p, req) : notFound();
}
