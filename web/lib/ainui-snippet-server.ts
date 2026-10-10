/**
 * Answers `GET /<org>/git/<repo>/…` with `Accept: application/vnd.ain.ui+json`
 * (docs/AINUI-LINK-SNIPPETS.md): resolves the pretty URL like the pages do
 * (lib/git-slug.ts, lib/git-urls.ts), gates the ACTOR the consumer names
 * (lib/ainui-actor.ts), reads the repo through the drive's agent and builds the
 * snippet with the pure builders in lib/ainui-snippet.ts. The deployments block
 * is read from ainize best-effort (§5): the public by-repo row, then the list with
 * aindrive's own machine token + the actor; anything failing leaves the block out.
 */
import { NextResponse } from "next/server";
import { gateActingCaller, resolveActingCaller } from "./ainui-actor";
import { AINUI_MEDIA_TYPE, deniedSnippet, fileSnippet, repoSnippet, snippetResponse, type AinuiSnippet } from "./ainui-snippet";
import { fetchProjectByRepo, projectPageUrl, type AinizeDeployment, type AinizeProject } from "./ainize-projects";
import { gitCloneUrl } from "./git-clone-url";
import { readManifest, runnableFiles } from "./git-manifest";
import { workingCopyPath } from "./git-paths";
import { resolveGitSlug } from "./git-slug";
import { gitUrl, parseGitUrlPath, type GitUrlTarget } from "./git-urls";
import { isTextByName, looksLikeText } from "./text-kind";
import { lookupMime } from "./mime";
import type { GitMeta } from "./protocol";
import { callAgent } from "./rpc";
import { ainizeUrl, languageFor } from "./run-ainize";
import { serviceToken } from "./sso/service-token";
import { requestOrigin } from "./shared-items";
import { log } from "./logger.js";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { "Content-Type": AINUI_MEDIA_TYPE, "Cache-Control": "private, no-store", Vary: "Accept, Authorization, X-AIN-Actor", ...headers } });
const notFound = () => json(404, { error: "not found" });

export const AINIZE_TIMEOUT_MS = 3_000;

/**
 * The snippet for a pretty repo URL, or the error the doc names. `path` is the
 * still-encoded segments after `/<slug>/git/`.
 */
export async function answerAinuiSnippet(req: Request, slug: string, path: string[]): Promise<Response> {
  const caller = await resolveActingCaller(req);
  if (caller.kind === "none") return json(401, { error: "service token required" }, { "WWW-Authenticate": "Bearer" });
  if (caller.kind === "refused") return json(caller.status, caller.body, caller.status === 401 ? { "WWW-Authenticate": 'Bearer error="invalid_token"' } : {});
  const driveId = resolveGitSlug(slug);
  const target = driveId ? parseGitUrlPath(path) : null;
  if (!driveId || !target) return notFound();
  const repoPath = workingCopyPath(target.repo);
  const origin = requestOrigin(req);
  const site = { org: slug, repo: target.repo };
  const pageUrl = `${origin}${gitUrl(site, target.view === "raw" ? { ...target, view: "blob" } : target)}`;

  const gate = await gateActingCaller(driveId, repoPath, caller, "viewer");
  if ("denied" in gate) {
    // An actor without access sees the sign-in surface; a drive that does not exist, or a path nobody may
    // name (`.aindrive/`), is "not found" — exactly what the HTML page tells the same person.
    if (gate.status === 404 || gate.status === 400) return notFound();
    if (gate.status === 402) return json(402, gate.body);
    return snippetResponse(deniedSnippet(new URL(origin).host, `${slug}/${target.repo}`, pageUrl), 403);
  }
  const { drive } = gate;
  let meta: GitMeta;
  try { meta = await callAgent(driveId, drive.drive_secret, { method: "git-meta", repo: repoPath }, { timeoutMs: 15_000 }); }
  catch { return json(503, { error: "drive offline" }); }
  if (!meta.exists) return notFound();

  const manifest = await readManifest(driveId, drive.drive_secret, repoPath);
  const runEndpoint = `${origin}/api/drives/${encodeURIComponent(driveId)}/run`;
  const inputs = manifest?.inputs ?? [];

  if (target.view === "blob" || target.view === "raw") {
    // `HEAD` names the checked-out branch: a consumer that only knows the drive path (AIN Teams' drive view asks for
    // `…/blob/HEAD/<file>`) gets the same snippet — and the same ▶ Run — as the branch URL.
    const ref = target.ref && target.ref !== "HEAD" ? target.ref : meta.branch;
    let shown;
    try { shown = await callAgent(driveId, drive.drive_secret, { method: "git-show", repo: repoPath, ref, path: target.path, maxBytes: 64 * 1024 }, { timeoutMs: 20_000 }); }
    catch (e) {
      const msg = (e as Error).message || "";
      return /no such path|unknown ref|is a directory|not a git repository/.test(msg) ? notFound() : json(503, { error: "drive offline" });
    }
    const bytes = Buffer.from(shown.content, "base64");
    const mime = lookupMime(target.path);
    const isText = isTextByName(target.path) || (!mime && looksLikeText(bytes)) || (!!mime && /^text\/|json|javascript|xml/.test(mime));
    // The run executes the working tree: only the checked-out branch's file can be ▶ Run.
    const runnable = !!languageFor(target.path) && ref === meta.branch;
    return snippetResponse(fileSnippet({
      org: slug, repo: target.repo, ref, path: target.path, size: shown.size,
      content: isText ? bytes.toString("utf8") : null,
      // The page and raw links name the resolved ref, so a `HEAD` request yields the branch's canonical URLs.
      pageUrl: `${origin}${gitUrl(site, { view: "blob", ref, path: target.path })}`,
      rawUrl: `${origin}${gitUrl(site, { view: "raw", ref, path: target.path })}`,
      run: runnable ? { inputs, endpoint: runEndpoint, repoPath } : null,
    }));
  }

  const entry = manifest?.entry ?? (await runnableFiles(driveId, drive.drive_secret, repoPath))[0] ?? null;
  const ainize = await ainizeBlock(driveId, repoPath, origin, caller.kind === "actor" ? caller.subject : null);
  return snippetResponse(repoSnippet({
    org: slug, repo: target.repo, branch: meta.branch, head: meta.head,
    pageUrl: `${origin}${gitUrl(site, { view: "tree", ref: null, path: "" })}`,
    run: entry ? { entry, inputs, endpoint: runEndpoint, repoPath } : null,
    ainize,
  }));
}

/**
 * The bound ainize project and its newest deployments, for the actor. Best
 * effort: the public by-repo row names the project and its latest deployment;
 * the full list needs aindrive's machine token for ainize plus the actor
 * (ainize answers it when the actor may see the project). Null = no block.
 */
export async function ainizeBlock(driveId: string, repoPath: string, origin: string, subject: string | null, fetchImpl: typeof fetch = fetch): Promise<{ project: AinizeProject; deployments: AinizeDeployment[]; pageUrl: string } | null> {
  const base = ainizeUrl();
  const cloneUrl = gitCloneUrl(origin, driveId, repoPath);
  const timeout = () => AbortSignal.timeout(AINIZE_TIMEOUT_MS);
  const project = await fetchProjectByRepo(base, cloneUrl, fetchImpl, timeout());
  if (!project) return null;
  let deployments: AinizeDeployment[] = project.lastDeployment ? [project.lastDeployment] : [];
  if (subject) {
    try {
      const token = await serviceToken(base);
      if (token) {
        const res = await fetchImpl(`${base}/api/projects/${encodeURIComponent(project.id)}/deployments`, {
          headers: { accept: "application/json", authorization: `Bearer ${token}`, "x-ain-actor": subject }, signal: timeout(),
        });
        if (res.ok) {
          const j = (await res.json()) as { deployments?: AinizeDeployment[] } | AinizeDeployment[];
          const list = Array.isArray(j) ? j : Array.isArray(j?.deployments) ? j.deployments : [];
          if (list.length) deployments = list.filter((d) => d && typeof d.id === "string").slice(0, 3);
        }
      }
    } catch (e) {
      log.warn({ ns: "aindrive.ainui", err: (e as Error).message }, "deployments list from ainize unavailable; showing the newest only");
    }
  }
  return { project, deployments, pageUrl: projectPageUrl(base, project) };
}

export type { AinuiSnippet };
