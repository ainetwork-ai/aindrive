import { NextResponse } from "next/server";
import { requireDriveRole } from "@/lib/require-access";
import { AgentError, callAgent } from "@/lib/rpc";
import { normalizePath } from "@/lib/path";
import { requestOrigin } from "@/lib/shared-items";
import { gitCloneUrl } from "@/lib/git-clone-url";
import { ainizeUrl } from "@/lib/run-ainize";

/**
 * GET /api/drives/:driveId/git-meta?repo=<folder>
 *
 * What the web git panel shows for a folder (components/git-panel.tsx): the
 * agent's `git-meta` (exists, branch, HEAD, last 10 commits, dirty count) plus
 * the URL to clone the repo from — the friendly `/<org-slug>/git/<repo>` when
 * the drive is shared with exactly one resolvable org, else the drive-id form
 * (lib/git-panel.ts). Viewer-gated at the folder, like fs/list. A plain folder
 * answers `{ exists: false }` so the panel simply stays hidden.
 */
export async function GET(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const raw = new URL(req.url).searchParams.get("repo");
  if (raw === null) return NextResponse.json({ error: "repo required" }, { status: 400 });
  let repo: string;
  try { repo = normalizePath(raw); }
  catch { return NextResponse.json({ error: "invalid path" }, { status: 400 }); }
  const gate = await requireDriveRole(driveId, repo, { min: "viewer" });
  if (gate instanceof NextResponse) return gate;
  try {
    const meta = await callAgent(driveId, gate.drive.drive_secret, { method: "git-meta", repo }, { timeoutMs: 15_000 });
    if (!meta.exists) return NextResponse.json({ exists: false });
    const { method: _m, ...rest } = meta;
    return NextResponse.json({ ...rest, cloneUrl: gitCloneUrl(requestOrigin(req), driveId, repo), ainizeUrl: ainizeUrl() });
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
