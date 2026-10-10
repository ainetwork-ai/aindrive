import { NextResponse } from "next/server";
import { z } from "zod";
import { requireDriveRole } from "@/lib/require-access";
import { AgentError, callAgent } from "@/lib/rpc";
import { getUser } from "@/lib/session";
import { zRequiredPath } from "@/lib/zod-helpers";

const Body = z.object({
  repo: zRequiredPath,
  message: z.string().trim().min(1, "commit message required").max(4000),
  /** true (default): stage everything first (VS Code's "stage all & commit"); false: commit only what is staged */
  all: z.boolean().optional(),
});

/**
 * POST /api/drives/:driveId/git-commit  { repo, message, all? }
 *
 * Commits in the repo's WORKING COPY on the drive's agent — everything
 * (`git add -A && git commit`, `all` true/default) or only what is staged
 * (`all: false`) — authored by the signed-in user (name + email from their
 * account). A commit deploys nothing: the panel's Push (git-sc) moves it into
 * the bare remote and fires the project hook, as a push over HTTP/SSH does.
 * Editor-gated at the repo folder — the same role that may push to it. The
 * agent refuses an empty message, a clean tree, nothing staged and a non-repo;
 * those come back as 400 with the agent's message.
 */
export async function POST(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: body.error.issues[0]?.message || "invalid input" }, { status: 400 });
  const gate = await requireDriveRole(driveId, body.data.repo, { min: "editor" });
  if (gate instanceof NextResponse) return gate;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "forbidden" }, { status: 401 });
  try {
    const r = await callAgent(driveId, gate.drive.drive_secret, {
      method: "git-commit", repo: body.data.repo, message: body.data.message, all: body.data.all ?? true,
      authorName: user.name || user.email, authorEmail: user.email,
    }, { timeoutMs: 30_000 });
    return NextResponse.json({ sha: r.sha });
  } catch (e) {
    const err = e as AgentError;
    const userError = /commit message required|nothing to commit|nothing staged|not a git repository|bare repository/.test(err.message);
    return NextResponse.json({ error: err.message }, { status: userError ? 400 : (err.status ?? 500) });
  }
}
