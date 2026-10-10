import { NextResponse } from "next/server";
import { requireDriveRole } from "@/lib/require-access";
import { resolveGitSlug } from "@/lib/git-slug";
import { callAgent } from "@/lib/rpc";
import { requestOrigin } from "@/lib/shared-items";
import { GIT_REPOS_DIR, workingCopyOf } from "@/lib/git-paths";
import type { DriveEntry, GitCommit } from "@/lib/protocol";

export const dynamic = "force-dynamic";

/** One row of an organization's repositories, as ainize's `/<org>` page lists them beside its projects. */
export type OrgRepository = {
  name: string;
  /** The friendly clone URL, `https://<host>/<slug>/git/<name>`. */
  cloneUrl: string;
  headSha: string | null;
  headSubject: string | null;
  /** The working copy's last modification, ms since the epoch. */
  updatedAt: number;
  /** Whether `ainize.json` sits at the repo root (what makes a push deploy on ainize). */
  hasManifest: boolean;
};

const MANIFEST = "ainize.json";

/**
 * GET /api/orgs/:slug/repositories
 *
 * The drive folder `repositories/` of the drive an AIN SSO organization slug resolves to
 * (lib/git-slug.ts — the same rule as `/<slug>/git/<repo>`), one row per repo:
 * `{ driveId, driveUrl, repositories: [{ name, cloneUrl, headSha, headSubject, updatedAt, hasManifest }] }`.
 * This is what ainize's organization page (`ainize.ai/<org>`) merges with its own projects, so a
 * repo shows there before it was ever pushed or bound.
 *
 * Who: a viewer of the `repositories/` folder — a signed-in member through the org share, or a
 * trusted first-party application acting as itself with an AIN SSO machine token (ainize-node
 * reading on the page's behalf; lib/sso/service-principal.ts, `service: true`). Anonymous → 401,
 * a stranger → 403, exactly as the gate decides. An unresolvable slug is 404 `{"error":"not found"}`,
 * the same body as the git route, so the URL never says which organizations exist.
 *
 * Each repo's HEAD comes from the agent's `git-meta` (bounded, in parallel); a repo the agent
 * cannot read still lists, with null HEAD. A `.git` sibling is the bare remote of its working copy
 * (lib/git-paths.ts) and is folded into that one row.
 */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const driveId = resolveGitSlug(slug);
  if (!driveId) return NextResponse.json({ error: "not found" }, { status: 404 });
  const gate = await requireDriveRole(driveId, GIT_REPOS_DIR, { min: "viewer", req, service: true });
  if (gate instanceof NextResponse) return gate;
  const secret = gate.drive.drive_secret;
  const origin = requestOrigin(req);

  let entries: DriveEntry[] = [];
  try {
    const r = (await callAgent(driveId, secret, { method: "list", path: GIT_REPOS_DIR }, { timeoutMs: 10_000 })) as { entries?: DriveEntry[] };
    entries = (r.entries ?? []).filter((e) => e.isDir && !e.name.startsWith("."));
  } catch {
    // No `repositories/` folder yet (or the agent is offline): an organization with no repositories.
    entries = [];
  }
  // A working copy and its bare sibling are one repo; a bare alone (legacy layout) is still a repo.
  const byName = new Map<string, DriveEntry>();
  for (const e of entries) {
    const name = workingCopyOf(e.name);
    const prior = byName.get(name);
    if (!prior || (prior.name.endsWith(".git") && !e.name.endsWith(".git"))) byName.set(name, e);
  }
  const rows = await Promise.all([...byName.entries()].map(async ([name, e]): Promise<OrgRepository> => {
    const repo = `${GIT_REPOS_DIR}/${e.name}`;
    let head: GitCommit | null = null;
    try {
      const meta = (await callAgent(driveId, secret, { method: "git-meta", repo }, { timeoutMs: 10_000 })) as { exists: boolean; head?: GitCommit | null };
      head = meta.exists ? meta.head ?? null : null;
    } catch { head = null; }
    let hasManifest = false;
    try {
      const l = (await callAgent(driveId, secret, { method: "list", path: repo }, { timeoutMs: 5_000 })) as { entries?: DriveEntry[] };
      hasManifest = (l.entries ?? []).some((x) => !x.isDir && x.name === MANIFEST);
    } catch { hasManifest = false; }
    return {
      name, cloneUrl: `${origin}/${encodeURIComponent(slug)}/git/${encodeURIComponent(name)}`,
      headSha: head?.sha ?? null, headSubject: head?.subject ?? null, updatedAt: e.mtimeMs ?? 0, hasManifest,
    };
  }));
  rows.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
  return NextResponse.json(
    { driveId, driveUrl: `${origin}/d/${encodeURIComponent(driveId)}?path=${encodeURIComponent(GIT_REPOS_DIR)}`, repositories: rows },
    { headers: { "Cache-Control": "no-store" } },
  );
}
