import { NextResponse } from "next/server";
import { z } from "zod";
import { requireDriveRole } from "@/lib/require-access";
import { zRequiredPath } from "@/lib/zod-helpers";
import { projectIdFor, removeProjectHook, storeProjectHook } from "@/lib/git-project-hooks";

const Body = z.object({
  repo: zRequiredPath,
  projectId: z.string().trim().min(1).max(200),
  /** returned once by ainize `POST /api/projects`; sealed at rest, never read back over HTTP */
  webhookSecret: z.string().min(8).max(4000),
});

/**
 * POST /api/drives/:driveId/git-connect  { repo, projectId, webhookSecret }
 *
 * Binds a repo folder to an ainize Project so a push there calls the project's
 * hook (lib/git-project-hooks.ts). The browser's "Connect to ainize" flow
 * creates the project on ainize and posts its id + one-time webhookSecret here.
 * Editor at the repo (the role that may push). GET answers `{ projectId }` or
 * `{ projectId: null }` (viewer); DELETE unbinds (editor).
 */
export async function POST(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const gate = await requireDriveRole(driveId, body.data.repo, { min: "editor" });
  if (gate instanceof NextResponse) return gate;
  try {
    storeProjectHook(driveId, body.data.repo, body.data.projectId, body.data.webhookSecret, gate.userId);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, projectId: body.data.projectId });
}

export async function GET(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const repo = new URL(req.url).searchParams.get("repo");
  if (repo === null) return NextResponse.json({ error: "repo required" }, { status: 400 });
  const gate = await requireDriveRole(driveId, repo, { min: "viewer" });
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ projectId: projectIdFor(driveId, repo) });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const repo = new URL(req.url).searchParams.get("repo");
  if (repo === null) return NextResponse.json({ error: "repo required" }, { status: 400 });
  const gate = await requireDriveRole(driveId, repo, { min: "editor" });
  if (gate instanceof NextResponse) return gate;
  removeProjectHook(driveId, repo);
  return NextResponse.json({ ok: true });
}
