// Server-renderable parts of the GitHub-like repo pages (app/d/by-slug): the
// page frame with the `org / repo / path` breadcrumb and ref switcher, a tree
// listing at a ref, a read-only file view, the commit list and one commit's
// detail. No state: the only client piece is the <select> that navigates
// (RefSwitcher, components/git-site.tsx). The checked-out branch's tree and
// files are NOT rendered here — they are the drive shell with pretty URLs
// (components/drive-shell.tsx `git` prop), so editing keeps working there.
import clsx from "clsx";
import { Folder, FileText, GitCommitHorizontal, History, Rocket } from "lucide-react";
import type { GitCommit, GitCommitDetail, GitCommitFull, GitTreeEntry } from "@/lib/protocol";
import { gitCrumbs, gitUrl, type GitSite } from "@/lib/git-urls";
import { relativeTime, shortSha } from "@/lib/git-panel";
import { RefSwitcher } from "./git-site";

export type GitFrameProps = {
  site: GitSite;
  /** the ref the page shows; `defaultBranch` the checked-out branch (`/tree/<default>` is the repo URL itself) */
  gitRef: string;
  defaultBranch: string;
  branches: string[];
  /** path inside the repo the breadcrumb spells out ("" at the root) */
  path: string;
  /** where the ref switcher navigates for another ref (tree/blob of the same path, commits, …) */
  switchView: "tree" | "blob" | "commits";
  readOnly: boolean;
  /** `/d/<driveId>` — where the org crumb goes (the drive itself, outside the repo) */
  driveHref: string;
  driveName: string;
  children: React.ReactNode;
};

const link = "hover:underline text-drive-accent";
const tab = (active: boolean) => clsx("inline-flex items-center gap-1 rounded-md px-2 py-1 text-caption font-medium", active ? "bg-drive-hover text-drive-text" : "text-drive-muted hover:text-drive-text");

/** The page frame: breadcrumb (org / repo / path), ref switcher, tabs (Code · Commits · Deployments), read-only banner. */
export function GitPageFrame({ site, gitRef, defaultBranch, branches, path, switchView, readOnly, driveHref, driveName, children }: GitFrameProps) {
  const opts = { defaultBranch };
  const crumbs = gitCrumbs(site, gitRef, path, opts);
  const activeTab = switchView === "commits" ? "commits" : "code";
  return (
    <main className="min-h-screen bg-white text-body text-drive-text" data-testid="git-page">
      <header className="border-b border-drive-border bg-white px-4 sm:px-8 py-3">
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm min-w-0">
          <a href={driveHref} className={clsx(link, "font-medium")} title={driveName}>{site.org}</a>
          {crumbs.map((c, i) => (
            <span key={c.href} className="flex items-center gap-1 min-w-0">
              <span className="text-drive-muted">/</span>
              {i === crumbs.length - 1
                ? <span className="font-semibold truncate">{c.label}</span>
                : <a href={c.href} className={clsx(link, i === 0 && "font-medium")}>{c.label}</a>}
            </span>
          ))}
        </nav>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <RefSwitcher site={site} gitRef={gitRef} defaultBranch={defaultBranch} branches={branches} path={path} view={switchView} />
          <nav className="flex items-center gap-1 ml-auto" aria-label="Repository views">
            <a href={gitUrl(site, { view: "tree", ref: gitRef, path: "" }, opts)} className={tab(activeTab === "code")}><FileText className="w-3.5 h-3.5" aria-hidden="true" /> Code</a>
            <a href={gitUrl(site, { view: "commits", ref: gitRef }, opts)} className={tab(activeTab === "commits")}><History className="w-3.5 h-3.5" aria-hidden="true" /> Commits</a>
            <a href={gitUrl(site, { view: "deployments" })} className={tab(false)}><Rocket className="w-3.5 h-3.5" aria-hidden="true" /> Deployments</a>
          </nav>
        </div>
        {readOnly && (
          <p className="mt-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-1.5 text-caption text-amber-800" role="note" data-testid="read-only-banner">
            read-only: viewing <span className="font-mono">{gitRef}</span> — files can be edited on <a className="underline" href={gitUrl(site, { view: switchView === "commits" ? "commits" : switchView, ref: defaultBranch, path } as never, opts)}>{defaultBranch}</a>, the checked-out branch.
          </p>
        )}
      </header>
      <div className="px-4 sm:px-8 py-4">{children}</div>
    </main>
  );
}

const prettyBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** One folder of a tree at a ref: name · last commit subject · when, folders first (the agent sorts). */
export function GitTreeTable({ site, gitRef, path, entries, defaultBranch }: { site: GitSite; gitRef: string; path: string; entries: GitTreeEntry[]; defaultBranch: string }) {
  const opts = { defaultBranch };
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return (
    <table className="w-full border border-drive-border rounded-xl overflow-hidden text-caption" data-testid="git-tree">
      <tbody className="divide-y divide-drive-border">
        {path && (
          <tr><td colSpan={4} className="px-3 h-9"><a href={gitUrl(site, { view: "tree", ref: gitRef, path: parent }, opts)} className={link}>..</a></td></tr>
        )}
        {entries.length === 0 && <tr><td colSpan={4} className="px-3 h-12 text-drive-muted">Empty folder.</td></tr>}
        {entries.map((e) => {
          const p = path ? `${path}/${e.name}` : e.name;
          const href = e.type === "tree" ? gitUrl(site, { view: "tree", ref: gitRef, path: p }, opts) : gitUrl(site, { view: "blob", ref: gitRef, path: p }, opts);
          return (
            <tr key={e.name} className="hover:bg-drive-hover">
              <td className="px-3 h-9 w-6 align-middle text-drive-muted">
                {e.type === "tree" ? <Folder className="w-4 h-4 text-drive-accent" aria-hidden="true" /> : <FileText className="w-4 h-4" aria-hidden="true" />}
              </td>
              <td className="px-1 align-middle font-medium"><a href={href} className="hover:underline">{e.name}</a></td>
              <td className="px-3 align-middle text-drive-muted truncate max-w-[40vw]">
                {e.lastCommit ? <a href={gitUrl(site, { view: "commit", sha: e.lastCommit.sha })} className="hover:underline">{e.lastCommit.subject}</a> : null}
              </td>
              <td className="px-3 align-middle text-right text-drive-muted whitespace-nowrap tabular-nums">
                {e.lastCommit ? relativeTime(e.lastCommit.date) : e.type === "blob" ? prettyBytes(e.size) : ""}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** A file at a ref other than the checked-out branch: text with line numbers, an image inline, else a download link. */
export function GitBlobView({ site, gitRef, path, bytes, size, truncated, isText, mime, defaultBranch }: {
  site: GitSite; gitRef: string; path: string; bytes: Uint8Array; size: number; truncated: boolean; isText: boolean; mime: string | null; defaultBranch: string;
}) {
  const opts = { defaultBranch };
  const rawHref = gitUrl(site, { view: "raw", ref: gitRef, path }, opts);
  const historyHref = `${gitUrl(site, { view: "commits", ref: gitRef }, opts)}?path=${encodeURIComponent(path)}`;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const text = isText ? new TextDecoder().decode(bytes) : null;
  const lines = text === null ? [] : text.replace(/\n$/, "").split("\n");
  return (
    <section className="border border-drive-border rounded-xl overflow-hidden" data-testid="git-blob">
      <div className="flex items-center gap-3 px-3 h-10 border-b border-drive-border text-caption bg-drive-panel">
        <span className="font-medium truncate">{name}</span>
        <span className="text-drive-muted">{lines.length ? `${lines.length} lines · ` : ""}{prettyBytes(size)}{truncated ? " · showing the first part" : ""}</span>
        <span className="ml-auto inline-flex items-center gap-3">
          <a href={rawHref} className="font-medium text-drive-muted hover:text-drive-text">Raw</a>
          <a href={historyHref} className="font-medium text-drive-muted hover:text-drive-text">History</a>
        </span>
      </div>
      {text !== null ? (
        <pre className="m-0 overflow-auto scrollbar-thin font-mono text-[12px] leading-5 text-drive-text">
          <table className="border-collapse"><tbody>
            {lines.map((l, i) => (
              <tr key={i} id={`L${i + 1}`}>
                <td className="select-none text-right pr-3 pl-3 text-drive-muted/70 align-top w-10 tabular-nums"><a href={`#L${i + 1}`}>{i + 1}</a></td>
                <td className="pr-3 whitespace-pre">{l}</td>
              </tr>
            ))}
          </tbody></table>
        </pre>
      ) : mime?.startsWith("image/") ? (
        <div className="p-4 flex justify-center bg-drive-panel">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={rawHref} alt={name} className="max-w-full h-auto rounded-md" />
        </div>
      ) : (
        <p className="px-3 py-6 text-caption text-drive-muted text-center">No inline preview — <a href={rawHref} className={link}>open the raw file</a>.</p>
      )}
    </section>
  );
}

/** The commit list of a ref (optionally for one path): subject · author · when · short sha, each a link to the commit. */
export function GitCommitList({ site, commits, path }: { site: GitSite; commits: (GitCommit | GitCommitFull)[]; path?: string }) {
  return (
    <section className="border border-drive-border rounded-xl overflow-hidden" data-testid="git-commits">
      {path && <div className="px-3 h-9 flex items-center text-caption text-drive-muted border-b border-drive-border">History of <span className="font-mono ml-1 text-drive-text">{path}</span></div>}
      {commits.length === 0 && <p className="px-3 py-6 text-caption text-drive-muted text-center">No commits yet.</p>}
      <ol className="divide-y divide-drive-border">
        {commits.map((c) => (
          <li key={c.sha} className="flex items-center gap-3 px-3 min-h-11 py-1.5 text-caption min-w-0">
            <GitCommitHorizontal className="w-3.5 h-3.5 text-drive-muted shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <a href={gitUrl(site, { view: "commit", sha: c.sha })} className="block truncate font-medium text-drive-text hover:underline">{c.subject}</a>
              <span className="block truncate text-drive-muted">{c.author} · {relativeTime(c.date)}</span>
            </span>
            <a href={gitUrl(site, { view: "commit", sha: c.sha })} className="font-mono text-drive-muted hover:text-drive-text shrink-0">{shortSha(c.sha)}</a>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** One commit: message, author, date, parents, changed files with +/−, and the patch coloured by line. */
export function GitCommitDetailView({ site, commit, defaultBranch }: { site: GitSite; commit: GitCommitDetail; defaultBranch: string }) {
  const total = commit.files.reduce((acc, f) => ({ a: acc.a + (f.additions ?? 0), d: acc.d + (f.deletions ?? 0) }), { a: 0, d: 0 });
  return (
    <article data-testid="git-commit" className="space-y-4">
      <header className="border border-drive-border rounded-xl p-4">
        <h1 className="text-lg font-semibold break-words">{commit.subject}</h1>
        {commit.body && <pre className="mt-2 whitespace-pre-wrap font-sans text-caption text-drive-text">{commit.body}</pre>}
        <p className="mt-3 text-caption text-drive-muted flex flex-wrap gap-x-3 gap-y-1">
          <span><span className="font-medium text-drive-text">{commit.author}</span> committed {relativeTime(commit.date)} <span title={commit.date}>({new Date(commit.date).toLocaleString()})</span></span>
          <span className="font-mono">commit {commit.sha}</span>
          {commit.parents.map((p) => <a key={p} href={gitUrl(site, { view: "commit", sha: p })} className="font-mono hover:underline">parent {shortSha(p)}</a>)}
          <a href={gitUrl(site, { view: "tree", ref: commit.sha, path: "" }, { defaultBranch })} className={link}>Browse files</a>
        </p>
      </header>
      <section className="border border-drive-border rounded-xl overflow-hidden text-caption">
        <div className="px-3 h-9 flex items-center gap-2 border-b border-drive-border text-drive-muted">
          {commit.files.length} changed {commit.files.length === 1 ? "file" : "files"}
          <span className="text-emerald-600 font-medium">+{total.a}</span>
          <span className="text-red-600 font-medium">−{total.d}</span>
        </div>
        <ul className="divide-y divide-drive-border">
          {commit.files.map((f) => (
            <li key={f.path} className="flex items-center gap-3 px-3 h-8 min-w-0">
              <a href={`#diff-${encodeURIComponent(f.path)}`} className="font-mono truncate flex-1 hover:underline">{f.path}</a>
              {f.additions === null ? <span className="text-drive-muted">binary</span> : (
                <span className="tabular-nums whitespace-nowrap"><span className="text-emerald-600">+{f.additions}</span> <span className="text-red-600">−{f.deletions}</span></span>
              )}
            </li>
          ))}
        </ul>
      </section>
      <GitPatch patch={commit.patch} truncated={commit.truncated} />
    </article>
  );
}

/** `git show --patch` output, one line per row, coloured by its first character; file headers are anchors. */
export function GitPatch({ patch, truncated }: { patch: string; truncated: boolean }) {
  const lines = patch.replace(/\n$/, "").split("\n");
  if (!patch.trim()) return null;
  return (
    <section className="border border-drive-border rounded-xl overflow-hidden" data-testid="git-patch">
      <pre className="m-0 overflow-auto scrollbar-thin font-mono text-[12px] leading-5">
        {lines.map((l, i) => {
          const file = l.startsWith("diff --git ") ? l.split(" b/").pop() ?? "" : null;
          const cls = file !== null ? "bg-drive-panel text-drive-text font-semibold border-t border-drive-border"
            : l.startsWith("+++") || l.startsWith("---") ? "text-drive-muted"
            : l.startsWith("@@") ? "bg-sky-50 text-sky-800"
            : l.startsWith("+") ? "bg-emerald-50 text-emerald-900"
            : l.startsWith("-") ? "bg-red-50 text-red-900"
            : "text-drive-text";
          return <div key={i} id={file !== null ? `diff-${encodeURIComponent(file)}` : undefined} className={clsx("px-3 whitespace-pre", cls)}>{l}</div>;
        })}
        {truncated && <div className="px-3 py-2 text-drive-muted">… patch cut at 512 KiB</div>}
      </pre>
    </section>
  );
}
