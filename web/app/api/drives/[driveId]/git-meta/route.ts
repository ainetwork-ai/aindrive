import { NextResponse } from "next/server";
import { requireDriveRole } from "@/lib/require-access";
import { AgentError, callAgent } from "@/lib/rpc";
import { normalizePath } from "@/lib/path";
import { requestOrigin } from "@/lib/shared-items";
import { gitCloneUrl } from "@/lib/git-clone-url";
import { ainizeUrl, languageFor } from "@/lib/run-ainize";
import { projectIdFor } from "@/lib/git-project-hooks";
import type { DriveEntry } from "@/lib/protocol";
import { parseManifestInputs, type ManifestInput } from "@/lib/run-inputs";

/** `ainize.json` at the repo root: what the project is and what to run. Absent / malformed → null. */
export type AinizeManifest = { entry: string | null; kind: string | null; name: string | null; inputs: ManifestInput[] };
const MANIFEST = "ainize.json";
async function readManifest(driveId: string, secret: string, repo: string): Promise<AinizeManifest | null> {
  const p = repo ? `${repo}/${MANIFEST}` : MANIFEST;
  try {
    const r = await callAgent(driveId, secret, { method: "read", path: p, encoding: "utf8", maxBytes: 64 * 1024 }, { timeoutMs: 5_000 });
    const j = JSON.parse(r.content) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    return { entry: str(j.entry), kind: str(j.kind), name: str(j.name), inputs: parseManifestInputs(j.inputs) };
  } catch { return null; }
}
/** The root's `.py`/`.js`/`.mjs` files by name, `main.*`/`index.*` first — the Run row's choices; the first is the default entry. */
async function runnableFiles(driveId: string, secret: string, repo: string): Promise<string[]> {
  try {
    const { entries } = await callAgent(driveId, secret, { method: "list", path: repo }, { timeoutMs: 5_000 }) as { entries: DriveEntry[] };
    const files = entries.filter((e) => !e.isDir && languageFor(e.name)).map((e) => e.name);
    const rank = (n: string) => (/^main\./i.test(n) ? 0 : /^index\./i.test(n) ? 1 : 2);
    files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    return files;
  } catch { return []; }
}

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
 * when one was connected here. Viewer-gated at the folder, like fs/list — also
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
    return NextResponse.json({
      ...rest,
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
