import { notFound, redirect } from "next/navigation";
import { getUser } from "@/lib/session";
import { staleSessionCheck } from "@/lib/sso/stale-session";
import { callAgent } from "@/lib/rpc";
import { gitPagePath, resolveGitSite, type ResolvedGitSite } from "@/lib/git-site";
import { gitUrl, type GitSite } from "@/lib/git-urls";
import { classifyKind, lookupMime } from "@/lib/mime";
import { isTextByName, looksLikeText } from "@/lib/text-kind";
import type { DriveEntry } from "@/lib/protocol";
import { DriveShell } from "@/components/drive-shell";
import { GitBlobView, GitCommitDetailView, GitCommitList, GitPageFrame, GitTreeTable } from "@/components/git-site-parts";
import { GitDeploymentsPage } from "@/components/git-site";

/**
 * GitHub's URL convention for a repo in a drive, served IN PLACE — the address
 * bar keeps `/<org>/git/<repo>/…` (next.config.ts rewrites a browser's request
 * here; lib/git-urls.ts spells the routes, lib/git-site.ts resolves them):
 *
 *   (root), tree/<ref>/<dir>     the checked-out branch → the drive shell (the same
 *                                listing + editor as /d/<id>?path=, with pretty URLs,
 *                                the git panel, Commit); any other ref → a read-only
 *                                listing from the object store (git-ls-tree)
 *   blob/<ref>/<file>            checked-out branch → the shell with the file open
 *                                (editor, Save, ▶ Run); other refs → read-only (git-show)
 *   commits/<ref>[?path=]        git-log · commit/<sha> → git-commit-detail
 *   deployments                  the panel's Deployments rows, full page
 *
 * The working tree IS the checked-out branch, which is why that one and only
 * that one is editable here; `raw/` is a route next door ([repo]/raw).
 */
export default async function GitRepoPage({ params, searchParams }: {
  params: Promise<{ slug: string; rest: string[] }>;
  searchParams: Promise<{ path?: string | string[] }>;
}) {
  const { slug, rest } = await params;
  const user = await getUser();
  const site = await resolveGitSite(slug, rest, user?.id ?? null);
  if (site.kind === "not_found") notFound();
  const here = `/${encodeURIComponent(slug)}/git/${rest.map(encodeURIComponent).join("/")}`;
  // Not signed in: the automatic AIN sign-in the middleware may have skipped, else the login page — back to THIS URL.
  if (site.kind === "denied" && !user) redirect((await staleSessionCheck(here)) ?? `/login?next=${encodeURIComponent(here)}`);
  if (site.kind === "denied") return <Denied />;
  if (site.kind === "offline") return <Offline />;
  return render(site, await searchParams);
}

async function render(site: Extract<ResolvedGitSite, { kind: "ok" }>, sp: { path?: string | string[] }) {
  const { target, refs, ref, readOnly, driveId, driveSecret, repoPath } = site;
  const gitSite: GitSite = { org: site.org, repo: target.repo };
  const defaultBranch = refs.head;
  const branches = refs.branches.map((b) => b.name);
  const frame = (path: string, switchView: "tree" | "blob" | "commits", children: React.ReactNode) => (
    <GitPageFrame site={gitSite} gitRef={ref} defaultBranch={defaultBranch} branches={branches} path={path} switchView={switchView}
      readOnly={readOnly} driveHref={`/d/${driveId}`} driveName={site.driveName}>
      {children}
    </GitPageFrame>
  );
  const agent = <M extends Parameters<typeof callAgent>[2]["method"]>(p: Extract<Parameters<typeof callAgent>[2], { method: M }>) =>
    callAgent<M>(driveId, driveSecret, p, { timeoutMs: 20_000 });
  const shell = (folder: string, open: DriveEntry | null) => (
    <DriveShell
      driveId={driveId} driveName={site.driveName}
      initialFolder={folder} scopeRoot={repoPath} initialOpen={open} initialRole={site.role}
      git={{ org: site.org, repo: target.repo, ref, defaultBranch, branches }}
    />
  );

  switch (target.view) {
    case "tree": {
      const folder = target.path ? `${repoPath}/${target.path}` : repoPath;
      if (!readOnly) return shell(folder, null);
      let tree;
      try { tree = await agent({ method: "git-ls-tree", repo: repoPath, ref, path: target.path }); }
      catch (e) { return gitError(e, frame, target.path, "tree"); }
      return frame(target.path, "tree", <GitTreeTable site={gitSite} gitRef={ref} path={target.path} entries={tree.entries} defaultBranch={defaultBranch} />);
    }
    case "blob": {
      if (!readOnly) {
        // The checked-out branch: the shell opens the file from the working tree (stat → DriveEntry), so
        // Save / Commit / Run act on what is on disk. A path that is not a file falls back to its folder.
        const drivePath = `${repoPath}/${target.path}`;
        const folder = drivePath.slice(0, drivePath.lastIndexOf("/"));
        let entry: DriveEntry | null = null;
        try {
          const r = await callAgent(driveId, driveSecret, { method: "stat", path: drivePath }, { timeoutMs: 5_000 });
          if (r.entry && !r.entry.isDir) entry = { ...r.entry, path: drivePath };
          else if (r.entry?.isDir) redirect(gitUrl(gitSite, { view: "tree", ref, path: target.path }, { defaultBranch }));
          else notFound();
        } catch (e) { if (isNextControlFlow(e)) throw e; }
        return shell(folder, entry);
      }
      let blob;
      try { blob = await agent({ method: "git-show", repo: repoPath, ref, path: target.path, maxBytes: 2 * 1024 * 1024 }); }
      catch (e) {
        if (/is a directory/.test((e as Error).message)) redirect(gitUrl(gitSite, { view: "tree", ref, path: target.path }, { defaultBranch }));
        return gitError(e, frame, target.path, "blob");
      }
      const bytes = new Uint8Array(Buffer.from(blob.content, "base64"));
      const mime = lookupMime(target.path);
      const isText = isTextByName(target.path) || classifyKind(target.path).kind === "text" || (!mime && looksLikeText(bytes));
      return frame(target.path, "blob", (
        <GitBlobView site={gitSite} gitRef={ref} path={target.path} bytes={bytes} size={blob.size} truncated={blob.truncated} isText={isText} mime={mime} defaultBranch={defaultBranch} />
      ));
    }
    case "commits": {
      const raw = Array.isArray(sp.path) ? sp.path[0] : sp.path;
      const path = (raw ?? "").split("/").filter((s) => s && s !== "." && s !== "..").join("/");
      let log;
      try { log = await agent({ method: "git-log", repo: repoPath, ref, path: path || undefined, n: 100 }); }
      catch (e) { return gitError(e, frame, path, "commits"); }
      return frame(path, "commits", <GitCommitList site={gitSite} commits={log.commits} path={path || undefined} />);
    }
    case "commit": {
      let detail;
      try { detail = await agent({ method: "git-commit-detail", repo: repoPath, sha: target.sha }); }
      catch (e) { return gitError(e, frame, "", "commits"); }
      return frame("", "commits", <GitCommitDetailView site={gitSite} commit={detail} defaultBranch={defaultBranch} />);
    }
    case "deployments":
      return frame("", "tree", <GitDeploymentsPage driveId={driveId} repo={repoPath} />);
    case "raw":
      // a browser lands on the raw ROUTE ([repo]/raw/[...rest]); this is unreachable but keeps the switch total
      notFound();
  }
}

function isNextControlFlow(e: unknown): boolean {
  const d = (e as { digest?: string })?.digest ?? "";
  return typeof d === "string" && (d.startsWith("NEXT_REDIRECT") || d === "NEXT_NOT_FOUND" || d.startsWith("NEXT_HTTP_ERROR_FALLBACK"));
}

/** An unknown ref / path at a ref is a 404; anything else from the agent renders as a message inside the frame. */
function gitError(e: unknown, frame: (path: string, v: "tree" | "blob" | "commits", c: React.ReactNode) => React.ReactNode, path: string, view: "tree" | "blob" | "commits") {
  if (isNextControlFlow(e)) throw e;
  const msg = (e as Error).message || "agent error";
  if (/unknown ref|no such path|not a git repository/.test(msg)) notFound();
  return frame(path, view, <p className="rounded-xl border border-drive-border p-6 text-caption text-drive-muted" role="alert">Couldn’t read the repository: {msg}</p>);
}

function Denied() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-sm bg-white border border-drive-border rounded-2xl p-6 shadow-drive">
        <h1 className="text-lg font-semibold">No access to this repository</h1>
        <p className="mt-2 text-sm text-drive-muted">This account can’t open it. If it was shared with another account, switch to that one; otherwise ask the owner to invite you.</p>
        <a href="/" className="mt-3 block text-center text-sm text-drive-accent hover:underline">Back to your drives</a>
      </div>
    </main>
  );
}

function Offline() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-sm bg-white border border-drive-border rounded-2xl p-6 shadow-drive">
        <h1 className="text-lg font-semibold">Drive offline</h1>
        <p className="mt-2 text-sm text-drive-muted">The drive’s agent isn’t connected right now, so the repository can’t be read. Try again when the drive is back online.</p>
      </div>
    </main>
  );
}
