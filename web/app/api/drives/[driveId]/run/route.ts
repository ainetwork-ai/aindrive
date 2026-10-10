import { NextResponse } from "next/server";
import { z } from "zod";
import { requireDriveRole } from "@/lib/require-access";
import { AgentError } from "@/lib/rpc";
import { zRequiredPath } from "@/lib/zod-helpers";
import { collectRepoFiles, languageFor, runOnAinize } from "@/lib/run-ainize";

const Body = z.object({
  repo: zRequiredPath,
  /** Entry file, relative to `repo` (e.g. "main.py"). */
  entry: z.string().min(1).max(1024),
});

/**
 * POST /api/drives/:driveId/run  { repo, entry }  →  text/event-stream
 *
 * Runs one `.py` / `.js` / `.mjs` file of a repo folder on ainize and streams
 * the result back unchanged (events `stdout`, `stderr`, `exit`, `error`). The
 * route gathers the repo's text files through the drive's agent (lib/run-ainize.ts:
 * `.git` and dependency dirs skipped, 32 files / 2 MiB cap) and forwards them to
 * `POST ${AINIZE_URL}/api/run` — see that module's header for the contract and
 * the dependency on ainize. Viewer-gated at the repo (reading is enough: the
 * code runs on ainize, not on the agent). ainize answering 503 (runner not
 * deployed / out of capacity) is relayed as 503 `{ error: "runner unavailable" }`.
 */
export async function POST(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const { repo, entry } = body.data;
  if (entry.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    return NextResponse.json({ error: "invalid entry" }, { status: 400 });
  }
  const language = languageFor(entry);
  if (!language) return NextResponse.json({ error: "only .py, .js and .mjs files can be run" }, { status: 400 });
  const gate = await requireDriveRole(driveId, repo, { min: "viewer" });
  if (gate instanceof NextResponse) return gate;
  let files;
  try {
    files = await collectRepoFiles(driveId, gate.drive.drive_secret, repo);
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
  if (!files.some((f) => f.path === entry)) return NextResponse.json({ error: "entry file not found in repo" }, { status: 404 });
  const upstream = await runOnAinize({ language, entry, files });
  if (upstream.status === 503) return NextResponse.json({ error: "runner unavailable" }, { status: 503 });
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return NextResponse.json({ error: `runner error (${upstream.status})`, detail: text.slice(0, 500) }, { status: 502 });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
