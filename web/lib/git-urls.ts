// GitHub's URL convention for a repo stored in a drive, pure (no React, no db):
//
//   /<org>/git/<repo>                          repo root  = tree at the default branch
//   /<org>/git/<repo>/tree/<ref>/<dir path>    folder listing at <ref>
//   /<org>/git/<repo>/blob/<ref>/<file path>   file view at <ref>
//   /<org>/git/<repo>/raw/<ref>/<file path>    raw bytes
//   /<org>/git/<repo>/commits/<ref>[?path=]    commit list
//   /<org>/git/<repo>/commit/<sha>             one commit
//   /<org>/git/<repo>/deployments              ainize deployments, full page
//
// `<org>` is the AIN SSO organization slug (lib/git-slug.ts resolves it to a
// drive), `<repo>` the repo folder at the drive root (a `.git` suffix is
// stripped, as git clients add it), `<ref>` a branch name or a sha — one URL
// segment, so a branch with a `/` in its name travels percent-encoded
// (`feature%2Fx`). Every path segment is encoded with encodeURIComponent.
//
// The same prefix is git smart-HTTP (app/[slug]/git/[...path]/route.ts):
// `…/info/refs`, `…/git-upload-pack`, `…/git-receive-pack`. isGitClientPath
// names those so the browser rewrite (next.config.ts) and the pages never
// claim them; a browser asking for one of them gets the route's own answer.

export type GitView = "tree" | "blob" | "raw" | "commits" | "commit" | "deployments";

/** What a URL points at inside a repo (no repo: `gitUrl` takes the site). */
export type GitTarget =
  | { view: "tree" | "blob" | "raw"; ref: string | null; path: string }
  | { view: "commits"; ref: string | null }
  | { view: "commit"; sha: string }
  | { view: "deployments" };
export type GitUrlTarget = GitTarget & { repo: string };

export type GitSite = { org: string; repo: string };

const VIEWS: ReadonlySet<string> = new Set(["tree", "blob", "raw", "commits", "commit", "deployments"]);
/** The last segments a git client asks for (smart HTTP); never a page. */
const GIT_CLIENT_TAILS = ["info/refs", "git-upload-pack", "git-receive-pack"];

/** A git smart-HTTP path (`<repo>/info/refs`, `<repo>/git-upload-pack`, `<repo>/git-receive-pack`). */
export function isGitClientPath(segments: readonly string[]): boolean {
  const joined = segments.join("/");
  return GIT_CLIENT_TAILS.some((t) => joined === t || joined.endsWith("/" + t));
}

const stripGitSuffix = (repo: string) => repo.replace(/\.git$/, "");
const SHA_RE = /^[0-9a-f]{4,40}$/i;

function decodeSeg(s: string): string | null {
  try { return decodeURIComponent(s); } catch { return null; }
}

/**
 * The URL segments after `/<org>/git/` → what to show. `null` for anything
 * that is not one of the shapes above (a git client path, an empty repo, an
 * unknown keyword, a path with `.`/`..`), so the caller answers 404. Segments
 * are decoded exactly once here; callers pass them still percent-encoded.
 */
export function parseGitUrlPath(rawSegments: readonly string[]): GitUrlTarget | null {
  const segments = rawSegments.filter((s) => s !== "");
  if (segments.length === 0 || isGitClientPath(segments)) return null;
  const decoded: string[] = [];
  for (const [i, s] of segments.entries()) {
    const d = decodeSeg(s);
    if (d === null || d === "" || d === "." || d === "..") return null;
    // Only the ref (third segment: tree/blob/raw/commits/<ref>) may carry a `/` — percent-encoded, as
    // `feature%2Fx` — and never as a revision expression or an option; every other segment is one name.
    if (i === 2 ? (d.startsWith("-") || d.includes("..") || /[\s~^:?*[\\]/.test(d)) : d.includes("/")) return null;
    decoded.push(d);
  }
  const repo = stripGitSuffix(decoded[0]);
  if (!repo || repo.startsWith(".")) return null;
  if (decoded.length === 1) return { repo, view: "tree", ref: null, path: "" };
  const view = decoded[1];
  if (!VIEWS.has(view)) return null;
  const rest = decoded.slice(2);
  switch (view) {
    case "deployments":
      return rest.length === 0 ? { repo, view: "deployments" } : null;
    case "commit":
      return rest.length === 1 && SHA_RE.test(rest[0]) ? { repo, view: "commit", sha: rest[0].toLowerCase() } : null;
    case "commits":
      return rest.length <= 1 ? { repo, view: "commits", ref: rest[0] ?? null } : null;
    case "tree":
      return { repo, view: "tree", ref: rest[0] ?? null, path: rest.slice(1).join("/") };
    case "blob":
    case "raw":
      // a file needs a ref and a path
      return rest.length >= 2 ? { repo, view, ref: rest[0], path: rest.slice(1).join("/") } : null;
    default:
      return null;
  }
}

const enc = (s: string) => encodeURIComponent(s);
const encPath = (p: string) => p.split("/").filter(Boolean).map(enc).join("/");

/** `/<org>/git/<repo>` */
export function gitRepoUrl(site: GitSite): string {
  return `/${enc(site.org)}/git/${enc(site.repo)}`;
}

/**
 * The URL for one target in a repo. A tree at the default branch's root is the
 * repo URL itself; everything else is spelled out, ref first.
 */
export function gitUrl(site: GitSite, target: GitTarget, opts: { defaultBranch?: string } = {}): string {
  const base = gitRepoUrl(site);
  switch (target.view) {
    case "deployments": return `${base}/deployments`;
    case "commit": return `${base}/commit/${enc(target.sha)}`;
    case "commits": return `${base}/commits/${enc(target.ref ?? opts.defaultBranch ?? "HEAD")}`;
    case "tree": {
      const ref = target.ref ?? opts.defaultBranch ?? null;
      const path = target.path.replace(/^\/+|\/+$/g, "");
      if (!path && (ref === null || ref === opts.defaultBranch)) return base;
      return `${base}/tree/${enc(ref ?? "HEAD")}${path ? "/" + encPath(path) : ""}`;
    }
    case "blob":
    case "raw":
      return `${base}/${target.view}/${enc(target.ref ?? opts.defaultBranch ?? "HEAD")}/${encPath(target.path)}`;
  }
}

/**
 * A drive path (`<repo>/<dir>/<file>`) seen from the repo: `<dir>/<file>`;
 * null when the path is not inside the repo.
 */
export function repoRelative(repo: string, drivePath: string): string | null {
  if (drivePath === repo) return "";
  return drivePath.startsWith(repo + "/") ? drivePath.slice(repo.length + 1) : null;
}

/** `org / repo / a / b` — the labels of a GitHub-like breadcrumb for a path inside the repo. */
export function gitCrumbs(site: GitSite, ref: string | null, path: string, opts: { defaultBranch?: string } = {}): { label: string; href: string }[] {
  const out = [{ label: site.repo, href: gitUrl(site, { view: "tree", ref, path: "" }, opts) }];
  const parts = path.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts) { cur = cur ? `${cur}/${p}` : p; out.push({ label: p, href: gitUrl(site, { view: "tree", ref, path: cur }, opts) }); }
  return out;
}

/**
 * The pretty-URL pathname (`/<org>/git/<repo>/…`) a browser is on → its target,
 * or null when it is not such a URL. Used by the drive shell to read a history
 * entry back (popstate) exactly as the server page parses it.
 */
export function parseGitPathname(pathname: string): { org: string; target: GitUrlTarget } | null {
  const segs = pathname.split("/").filter(Boolean);
  if (segs.length < 3 || segs[1] !== "git") return null;
  const org = decodeSeg(segs[0]);
  if (!org) return null;
  const target = parseGitUrlPath(segs.slice(2));
  return target ? { org, target } : null;
}

/**
 * The next.config.ts rewrite source (and the middleware matcher entry) for the
 * repo pages, kept here so a test can hold the three copies together: the
 * `:rest` pattern refuses the smart-HTTP tails, so `…/info/refs`,
 * `…/git-upload-pack` and `…/git-receive-pack` are never rewritten.
 */
export const GIT_PAGE_REWRITE_SOURCE = "/:slug/git/:rest((?!.*(?:^|/)(?:info/refs|git-upload-pack|git-receive-pack)$).+)";
