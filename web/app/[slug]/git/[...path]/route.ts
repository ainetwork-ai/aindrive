import { NextResponse } from "next/server";
import { gitHttpGET, gitHttpPOST } from "@/lib/git-http";
import { resolveGitSlug } from "@/lib/git-slug";

/**
 * Friendly git smart-HTTP URL for a repo stored inside a drive:
 *   https://<host>/<org-slug>/git/<repo-path>[.git]
 *     e.g. git clone https://<host>/comcom/git/clef-artwork-search
 *
 * `<org-slug>` is an AIN SSO organization slug; lib/git-slug.ts turns it into
 * the drive shared with that organization (rule documented there). The repo
 * path is `[...path]` as-is — a folder at the drive ROOT, no `git/` prefix is
 * added — and everything else (auth, upload/receive-pack, streaming) is the
 * same lib/git-http.ts the id-addressed /api/drives/<driveId>/git/… route uses,
 * so access control runs against the resolved drive and repo path.
 *
 * An unresolvable slug answers 404 {"error":"not found"}, the same body as a
 * malformed git path, so the URL never reveals which drives exist.
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

export async function GET(req: Request, { params }: Params) {
  const { slug, path } = await params;
  const driveId = resolveGitSlug(slug);
  if (!driveId) return notFound();
  return gitHttpGET(driveId, path, req);
}

export async function POST(req: Request, { params }: Params) {
  const { slug, path } = await params;
  const driveId = resolveGitSlug(slug);
  if (!driveId) return notFound();
  return gitHttpPOST(driveId, path, req);
}
