// Server side of the GitHub-like repo pages (app/d/by-slug/[slug]/[...rest]):
// the pretty URL `/<org>/git/<repo>/…` → which drive, which repo, which view
// (lib/git-urls.ts), whether the signed-in user may read it (the same drive
// gate as fs/list — lib/drive-gate.ts), and the repo's refs from the agent.
// The raw route (…/raw/<ref>/<path>, also reachable by a non-browser client
// through app/[slug]/git/[...path]) shares serveGitRaw.
import { gateDriveRoleForUser } from "./drive-gate";
import { getDrive } from "./drives";
import { resolveGitSlug } from "./git-slug";
import { gitUrl, parseGitUrlPath, type GitUrlTarget } from "./git-urls";
import { workingCopyPath } from "./git-paths";
import { lookupMime } from "./mime";
import { callAgent } from "./rpc";
import type { GitRefs } from "./protocol";
import { isTextByName, looksLikeText } from "./text-kind";

export type GitSiteRefs = Extract<GitRefs, { exists: true }>;

export type ResolvedGitSite =
  | { kind: "not_found" }
  | { kind: "denied"; status: number; driveId: string }
  | { kind: "offline"; driveId: string; target: GitUrlTarget }
  | { kind: "ok"; driveId: string; driveName: string; driveSecret: string; role: string; org: string; target: GitUrlTarget; refs: GitSiteRefs; ref: string; readOnly: boolean;
      /** the drive path of the repo's working copy — `repositories/<repo>` (lib/git-paths.ts): what every agent call names */
      repoPath: string };

/**
 * One call does the whole resolution. Order matters for what a URL reveals: an
 * unknown slug, an unparsable path and a folder that is not a repo are all
 * "not found", and the gate runs before the agent is asked anything — a
 * stranger learns nothing about which repos a drive holds.
 *
 * `ref` is the target's ref or the checked-out branch; `readOnly` is true for
 * any other ref — the working tree IS the checked-out branch, so only that
 * one can be edited through the drive editor.
 */
export async function resolveGitSite(slug: string, rest: readonly string[], userId: string | null): Promise<ResolvedGitSite> {
  const driveId = resolveGitSlug(slug);
  if (!driveId) return { kind: "not_found" };
  const target = parseGitUrlPath(rest);
  if (!target) return { kind: "not_found" };
  const repoPath = workingCopyPath(target.repo);
  const gate = await gateDriveRoleForUser(driveId, repoPath, { min: "viewer", userId });
  if ("denied" in gate) return gate.status === 404 ? { kind: "not_found" } : { kind: "denied", status: gate.status, driveId };
  const drive = getDrive(driveId);
  if (!drive) return { kind: "not_found" };
  let refs: GitRefs;
  try {
    refs = await callAgent(driveId, drive.drive_secret, { method: "git-refs", repo: repoPath }, { timeoutMs: 8_000 });
  } catch {
    return { kind: "offline", driveId, target };
  }
  if (!refs.exists) return { kind: "not_found" };
  const wanted = "ref" in target ? target.ref : null;
  const ref = wanted ?? refs.head;
  return {
    kind: "ok", driveId, driveName: drive.name, driveSecret: drive.drive_secret, role: gate.role, org: slug, target, refs, ref, repoPath,
    readOnly: ref !== refs.head,
  };
}

/** `Content-Type` for raw bytes: text/plain for anything code-like or sniffed as text, the mime type otherwise. */
export function rawContentType(path: string, bytes: Uint8Array): string {
  const mime = lookupMime(path);
  if (isTextByName(path) || !mime) return looksLikeText(bytes) || isTextByName(path) ? "text/plain; charset=utf-8" : "application/octet-stream";
  if (mime.startsWith("text/")) return `${mime}; charset=utf-8`;
  // HTML/SVG/XML served raw would run scripts on this origin (GitHub serves raw as text/plain too).
  if (/html|xml|javascript|json/.test(mime)) return "text/plain; charset=utf-8";
  return mime;
}

/**
 * GET …/raw/<ref>/<path>: the file's bytes at that ref. `Content-Disposition:
 * inline` with the filename; `nosniff` so the text/plain above is honoured.
 */
export async function serveGitRaw(site: Extract<ResolvedGitSite, { kind: "ok" }>): Promise<Response> {
  if (site.target.view !== "raw") return new Response("not found\n", { status: 404 });
  let r;
  try {
    r = await callAgent(site.driveId, site.driveSecret, { method: "git-show", repo: site.repoPath, ref: site.ref, path: site.target.path }, { timeoutMs: 20_000 });
  } catch (e) {
    const msg = (e as Error).message || "agent error";
    const status = /no such path|unknown ref|is a directory/.test(msg) ? 404 : (e as { status?: number }).status ?? 502;
    return new Response(`${status === 404 ? "not found" : msg}\n`, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
  const bytes = Buffer.from(r.content, "base64");
  const name = site.target.path.slice(site.target.path.lastIndexOf("/") + 1);
  return new Response(bytes, {
    status: r.truncated ? 206 : 200,
    headers: {
      "Content-Type": rawContentType(site.target.path, bytes),
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "X-Git-Sha": r.sha,
    },
  });
}

/** The repo page URL a sign-in should return to. */
export function gitPagePath(org: string, target: GitUrlTarget, defaultBranch?: string): string {
  return gitUrl({ org, repo: target.repo }, target, { defaultBranch });
}
