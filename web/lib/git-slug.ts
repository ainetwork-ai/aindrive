import { db } from "./db";

/**
 * Friendly git URL: `https://<host>/<slug>/git/<repo-path>` → which drive.
 *
 * Resolution rule (app/[slug]/git/[...path]/route.ts, lib/git-http.ts):
 *   1. A reserved top-level app name (`api`, `d`, `docs`, `login`, …; RESERVED
 *      below) is never a slug → null. Next already routes those static
 *      segments to their own pages, so this only matters for URLs none of them
 *      claim (e.g. /docs/git/x); listing them keeps the answer deterministic.
 *   2. Otherwise the slug is an AIN SSO **organization slug**: every
 *      sso_memberships row whose org_slug equals it case-insensitively, any
 *      issuer, names an (issuer, org_id). The drives shared with those orgs
 *      (drive_org_shares) are the candidates.
 *        - exactly one distinct drive → its id;
 *        - several → the one whose drives.name equals the slug
 *          case-insensitively (exactly one such), else null;
 *        - none (the slug matches no org, or the org has no shared drive) → null.
 *   3. null means the route answers 404 {"error":"not found"} — the same body
 *      lib/git-http.ts gives a malformed git path — so the URL never reveals
 *      which organizations or drives exist.
 *
 * This only FINDS the drive. Who may read or push the repo is decided
 * afterwards by requireDriveRole() against that drive and the repo path,
 * exactly as for /api/drives/<driveId>/git/…; an org member's role still
 * comes from lib/orgs.js (active membership, active creator, adapter on).
 */
export const RESERVED: ReadonlySet<string> = new Set([
  "api", "mcp", "a2a", "d", "s", "docs", "login", "signup", "sso", "oauth", "account",
  "download", "cli-login", "agui", "ainui", "forgot-password", "_next", "_dev",
]);

type SharedDriveRow = { id: string; name: string };

export function resolveGitSlug(slug: string): string | null {
  const s = (slug || "").trim();
  if (!s || RESERVED.has(s.toLowerCase())) return null;

  const rows = db.prepare(
    `SELECT DISTINCT d.id AS id, d.name AS name
     FROM drive_org_shares sh
     JOIN drives d ON d.id = sh.drive_id
     WHERE EXISTS (
       SELECT 1 FROM sso_memberships m
       WHERE m.issuer = sh.issuer AND m.org_id = sh.org_id AND m.org_slug = ? COLLATE NOCASE
     )
     ORDER BY d.id`,
  ).all(s) as SharedDriveRow[];

  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0].id;
  const lower = s.toLowerCase();
  const named = rows.filter((r) => (r.name || "").toLowerCase() === lower);
  return named.length === 1 ? named[0].id : null;
}
