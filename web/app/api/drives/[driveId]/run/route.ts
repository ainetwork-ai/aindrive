import { NextResponse } from "next/server";
import { z } from "zod";
import { requireDriveRole } from "@/lib/require-access";
import { AgentError } from "@/lib/rpc";
import { zRequiredPath } from "@/lib/zod-helpers";
import { collectRepoFiles, languageFor, runActorFor, runOnAinize, runProjectOnAinize, projectSourceOnAinize } from "@/lib/run-ainize";
import { validateRunEnv } from "@/lib/run-inputs";
import { gateActingCaller, resolveActingCaller } from "@/lib/ainui-actor";

import { projectHookFor } from "@/lib/git-project-hooks";

const Body = z.object({
  target: z.enum(["working-tree", "head", "commit", "deployed"]).default("working-tree"),
  sha: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
  repo: zRequiredPath,
  /** Entry file, relative to `repo` (e.g. "main.py"). */
  entry: z.string().min(1).max(1024),
  /** Answers to the manifest's `inputs`, as env (lib/run-inputs.ts: ≤ 16 upper-case names, ≤ 2 KiB each). */
  env: z.unknown().optional(),
});

/**
 * POST /api/drives/:driveId/run  { repo, entry, env? }  →  text/event-stream
 *
 * Runs one `.py` / `.js` / `.mjs` file of a repo folder on ainize and streams
 * the result back unchanged (events `stdout`, `stderr`, `exit`, `error`). The
 * route gathers the repo's text files through the drive's agent (lib/run-ainize.ts:
 * `.git` and dependency dirs skipped, 32 files / 2 MiB cap) and forwards them to
 * `POST ${AINIZE_URL}/api/run` — see that module's header for the contract and
 * the dependency on ainize. Viewer-gated at the repo (reading is enough: the
 * code runs on ainize, not on the agent). The run is FOR the signed-in person
 * (lib/run-ainize.ts runActorFor): ainize gives their script their own API key.
 * ainize answering 503 (runner not deployed / out of capacity) is relayed as
 * 503 `{ error: "runner unavailable" }`; a 401/403 about the person or about us
 * (`invalid_service_token`, `account_suspended`) is relayed with its status.
 *
 * A consumer application may press ▶ for a person (docs/AINUI-LINK-SNIPPETS.md
 * §2.2): `Authorization: Bearer <its AIN SSO machine token>` + `X-AIN-Actor:
 * <the person's subject>` (lib/ainui-actor.ts). The person is gated as the
 * account they are linked to here and the run is for them, exactly as if they
 * had pressed the button on the page; an application naming nobody is refused
 * (a run is always for someone).
 */
export async function POST(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const { repo, entry } = body.data;
  const env = validateRunEnv(body.data.env);
  if (env === null) return NextResponse.json({ error: "invalid env: at most 16 env entries named like ^[A-Za-z_][A-Za-z0-9_]*$, values up to 2 KiB" }, { status: 400 });
  if (entry.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    return NextResponse.json({ error: "invalid entry" }, { status: 400 });
  }
  const language = languageFor(entry);
  if (!language) return NextResponse.json({ error: "only .py, .js and .mjs files can be run" }, { status: 400 });
  const acting = await resolveActingCaller(req);
  let gate;
  if (acting.kind === "refused") return NextResponse.json(acting.body, { status: acting.status, headers: acting.status === 401 ? { "WWW-Authenticate": 'Bearer error="invalid_token"' } : {} });
  if (acting.kind === "app") return NextResponse.json({ error: "X-AIN-Actor required: a run is for a person" }, { status: 403 });
  if (acting.kind === "actor") {
    const g = await gateActingCaller(driveId, repo, acting, "viewer");
    if ("denied" in g) return NextResponse.json(g.body, { status: g.status });
    gate = g;
  } else {
    const g = await requireDriveRole(driveId, repo, { min: "viewer" });
    if (g instanceof NextResponse) return g;
    gate = g;
  }
  const actor = await runActorFor(gate.userId);
  if (body.data.target !== "working-tree") {
    const hook = projectHookFor(driveId, repo);
    if (!hook) return NextResponse.json({ error: "push this repository to bind its project first" }, { status: 409 });
    if (!actor) return NextResponse.json({ error: "sign in with AIN SSO to run a repository version" }, { status: 401 });
    if (body.data.target === "commit" && !body.data.sha) return NextResponse.json({ error: "select a commit to run" }, { status: 400 });
    if (body.data.target !== "commit" && body.data.sha) return NextResponse.json({ error: "sha is only used for a commit run" }, { status: 400 });
    const upstream = await runProjectOnAinize({ projectId: hook.projectId, target: body.data.target, sha: body.data.sha, entry, env, actor, signal: req.signal });
    return new Response(upstream.body, { status: upstream.status, headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store", "X-Accel-Buffering": "no", ...(upstream.headers.get("x-ainize-execution") ? { "X-Ainize-Execution": upstream.headers.get("x-ainize-execution")! } : {}) } });
  }
  let files;
  try {
    files = await collectRepoFiles(driveId, gate.drive.drive_secret, repo);
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
  if (!files.some((f) => f.path === entry)) return NextResponse.json({ error: "entry file not found in repo" }, { status: 404 });
  const upstream = await runOnAinize({ language, entry, files, env, actor, signal: req.signal });
  if (upstream.status === 503) return NextResponse.json({ error: "runner unavailable" }, { status: 503 });
  if (upstream.status === 401 || upstream.status === 403) {
    const body = await upstream.json().catch(() => ({})) as { error?: string; message?: string };
    return NextResponse.json({ error: body.error ?? "refused", detail: body.message ?? "" }, { status: upstream.status });
  }
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return NextResponse.json({ error: `runner error (${upstream.status})`, detail: text.slice(0, 500) }, { status: 502 });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}

/** GET retrieves the form from the immutable commit the Run button will execute. */
export async function GET(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const query = new URL(req.url).searchParams;
  const parsed = z.object({ repo: zRequiredPath, target: z.enum(['head', 'commit', 'deployed']), sha: z.string().regex(/^[a-f0-9]{40,64}$/).optional() }).safeParse({ repo: query.get('repo'), target: query.get('target') ?? 'head', ...(query.has('sha') ? { sha: query.get('sha') } : {}) });
  if (!parsed.success) return NextResponse.json({ error: 'invalid source target' }, { status: 400 });
  const { repo, target, sha } = parsed.data;
  if ((target === 'commit' && !sha) || (target !== 'commit' && sha)) return NextResponse.json({ error: 'sha is required only for a commit target' }, { status: 400 });
  const acting = await resolveActingCaller(req);
  if (acting.kind === 'refused') return NextResponse.json(acting.body, { status: acting.status });
  if (acting.kind === 'app') return NextResponse.json({ error: 'X-AIN-Actor required' }, { status: 403 });
  let gate;
  if (acting.kind === 'actor') {
    const result = await gateActingCaller(driveId, repo, acting, 'viewer');
    if ('denied' in result) return NextResponse.json(result.body, { status: result.status });
    gate = result;
  } else {
    const result = await requireDriveRole(driveId, repo, { min: 'viewer' });
    if (result instanceof NextResponse) return result;
    gate = result;
  }
  const hook = projectHookFor(driveId, repo);
  if (!hook) return NextResponse.json({ error: 'push this repository to bind its project first' }, { status: 409 });
  const actor = await runActorFor(gate.userId);
  if (!actor) return NextResponse.json({ error: 'sign in with AIN SSO to read a repository version' }, { status: 401 });
  try {
    const upstream = await projectSourceOnAinize({ projectId: hook.projectId, target, sha, actor, signal: req.signal });
    return new Response(upstream.body, { status: upstream.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
  } catch {
    return NextResponse.json({ error: 'repository source unavailable' }, { status: 503 });
  }
}
