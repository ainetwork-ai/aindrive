import { NextResponse } from "next/server";
import { requireDriveRole } from "@/lib/require-access";
import { AgentError, callAgent } from "@/lib/rpc";
import { normalizePath } from "@/lib/path";
import { requestOrigin } from "@/lib/shared-items";
import { gitCloneUrl } from "@/lib/git-clone-url";
import { ainizeUrl } from "@/lib/run-ainize";
import { projectIdFor } from "@/lib/git-project-hooks";
import type { GitStatus } from "@/lib/protocol";
import { readManifest, runnableFiles } from "@/lib/git-manifest";

/**
 * GET /api/drives/:driveId/git-meta?repo=<folder>
 *
 * What the web git panel shows for a folder (components/git-panel.tsx): the
 * agent's `git-meta` (exists, branch, HEAD, last 10 commits, dirty count) plus
 * the URL to clone the repo from — the friendly `/<org-slug>/git/<repo>` when
 * the drive is shared with exactly one resolvable org, else the drive-id form
 * (lib/git-panel.ts), the project's `ainize.json` manifest (`entry`, `kind`,
 * `name`, `inputs` — the fields the Run panel asks for, lib/run-inputs.ts) or the
 * root's first runnable file as `entry` for the panel's Run row (`runnable` lists
 * every root `.py`/`.js`/`.mjs`, the row's file selector),
 * and the ainize project bound to the repo (`projectId`, lib/git-project-hooks.ts)
 * when one was connected here, and `status` (agent `git-status`: staged / unstaged /
 * untracked, ahead/behind the bare remote — the panel's Source Control; absent
 * for a bare or unreadable repo). `layout` says whether the folder is a working
 * copy with its bare sibling, a legacy non-bare repo, or bare (lib/git-paths.ts).
 * Viewer-gated at the folder, like fs/list — also
 * for a trusted first-party application's machine token (lib/sso/service-principal.ts).
 * A plain folder answers `{ exists: false }` so the panel simply stays hidden.
 */
export async function GET(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const raw = new URL(req.url).searchParams.get("repo");
  if (raw === null) return NextResponse.json({ error: "repo required" }, { status: 400 });
  let repo: string;
  try { repo = normalizePath(raw); }
  catch { return NextResponse.json({ error: "invalid path" }, { status: 400 }); }
  const gate = await requireDriveRole(driveId, repo, { min: "viewer", req, service: true });
  if (gate instanceof NextResponse) return gate;
  try {
    const meta = await callAgent(driveId, gate.drive.drive_secret, { method: "git-meta", repo }, { timeoutMs: 15_000 });
    if (!meta.exists) return NextResponse.json({ exists: false });
    const { method: _m, ...rest } = meta;
    const secret = gate.drive.drive_secret;
    const manifest = await readManifest(driveId, secret, repo);
    const runnable = await runnableFiles(driveId, secret, repo);
    const entry = manifest?.entry ?? runnable[0] ?? null;
    let status: Omit<GitStatus, "method"> | null = null;
    if (meta.layout !== "bare") {
      try { const { method: _s, ...st } = await callAgent(driveId, secret, { method: "git-status", repo }, { timeoutMs: 15_000 }); status = st; } catch { status = null; }
    }
    return NextResponse.json({
      ...rest,
      status,
      cloneUrl: gitCloneUrl(requestOrigin(req), driveId, repo),
      ainizeUrl: ainizeUrl(),
      manifest,
      entry,
      runnable,
      projectId: projectIdFor(driveId, repo),
    });
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
