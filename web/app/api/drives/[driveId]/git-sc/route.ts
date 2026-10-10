import { NextResponse } from "next/server";
import { z } from "zod";
import { requireDriveRole } from "@/lib/require-access";
import { AgentError, callAgent } from "@/lib/rpc";
import { normalizePath } from "@/lib/path";
import { zRequiredPath } from "@/lib/zod-helpers";
import { notifyProjectOfRefUpdates } from "@/lib/git-project-hooks";
import { requestOrigin } from "@/lib/shared-items";

const Body = z.object({
  repo: zRequiredPath,
  action: z.enum(["stage", "unstage", "discard", "push", "pull"]),
  /** repo-relative paths for stage / unstage / discard */
  paths: z.array(z.string().min(1).max(4096)).max(500).optional(),
});

/**
 * Source control of a repo's working copy (components/git-panel.tsx, VS Code-like).
 *
 *   GET  ?repo=            → agent `git-status`: { branch, staged, unstaged, untracked, ahead, behind, hasRemote }
 *   POST { repo, action, paths? }
 *        stage / unstage   → agent `git-stage` on `paths`
 *        discard           → agent `git-discard` (tracked → checkout, untracked → removed; the UI confirms first)
 *        push              → agent `git-push` (working copy HEAD → the bare remote, lib/git-paths.ts), then the
 *                            ainize project hook fires for the moved ref exactly as after a push over HTTP/SSH
 *                            (lib/git-project-hooks.ts notifyProjectOfRefUpdates — this IS the deploy trigger;
 *                            a commit alone never is). Answers { ref, before, after }.
 *        pull              → agent `git-pull`: fast-forward from the bare; refused while the copy has changes.
 *
 * GET is viewer-gated at the repo (reading state); every POST is editor-gated —
 * the role that may push. Agent refusals the user caused (a dirty copy on pull,
 * an invalid path, legacy layout) come back as 400 with the agent's message.
 */
export async function GET(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const raw = new URL(req.url).searchParams.get("repo");
  if (raw === null) return NextResponse.json({ error: "repo required" }, { status: 400 });
  let repo: string;
  try { repo = normalizePath(raw); } catch { return NextResponse.json({ error: "invalid path" }, { status: 400 }); }
  const gate = await requireDriveRole(driveId, repo, { min: "viewer" });
  if (gate instanceof NextResponse) return gate;
  try {
    const { method: _m, ...st } = await callAgent(driveId, gate.drive.drive_secret, { method: "git-status", repo }, { timeoutMs: 15_000 });
    return NextResponse.json(st);
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: /not a git repository/.test(err.message) ? 404 : (err.status ?? 500) });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: body.error.issues[0]?.message || "invalid input" }, { status: 400 });
  const { repo, action, paths } = body.data;
  if ((action === "stage" || action === "unstage" || action === "discard") && !paths?.length) {
    return NextResponse.json({ error: "paths required" }, { status: 400 });
  }
  const gate = await requireDriveRole(driveId, repo, { min: "editor" });
  if (gate instanceof NextResponse) return gate;
  const secret = gate.drive.drive_secret;
  try {
    switch (action) {
      case "stage":
      case "unstage":
        await callAgent(driveId, secret, { method: "git-stage", repo, paths: paths!, unstage: action === "unstage" }, { timeoutMs: 30_000 });
        return NextResponse.json({ ok: true });
      case "discard": {
        const r = await callAgent(driveId, secret, { method: "git-discard", repo, paths: paths! }, { timeoutMs: 30_000 });
        return NextResponse.json({ ok: true, tracked: r.tracked, untracked: r.untracked });
      }
      case "pull": {
        const r = await callAgent(driveId, secret, { method: "git-pull", repo }, { timeoutMs: 60_000 });
        return NextResponse.json({ ok: true, sha: r.sha });
      }
      case "push": {
        const r = await callAgent(driveId, secret, { method: "git-push", repo }, { timeoutMs: 120_000 });
        if (r.before !== r.after) {
          void notifyProjectOfRefUpdates(driveId, repo, [{ ref: r.ref, before: r.before, after: r.after }], gate.userId, fetch, { driveSecret: secret, origin: requestOrigin(req) }).catch(() => {});
        }
        return NextResponse.json({ ok: true, ref: r.ref, before: r.before, after: r.after, moved: r.before !== r.after });
      }
    }
  } catch (e) {
    const err = e as AgentError;
    const userError = /has changes|invalid path|paths required|legacy layout|not a git repository|detached HEAD|not a fast-forward|pull failed/.test(err.message);
    return NextResponse.json({ error: err.message }, { status: userError ? 400 : (err.status ?? 500) });
  }
}
