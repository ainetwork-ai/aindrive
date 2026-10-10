"use client";
// Client pieces of the GitHub-like repo pages (lib/git-urls.ts): the branch
// switcher that navigates to the same view at another ref, and the full-page
// Deployments view, which reads the bound ainize project from the browser the
// way the git panel does (components/use-ainize-project.ts).
import { useEffect, useState } from "react";
import { GitBranch } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { gitUrl, type GitSite } from "@/lib/git-urls";
import { useAinizeProject } from "./use-ainize-project";
import { Deployments, type GitPanelMeta } from "./git-panel";

/** `<select>` of branches: picking one opens the same tree/blob path (or the commit list) at that ref. */
export function RefSwitcher({ site, gitRef, defaultBranch, branches, path, view }: {
  site: GitSite; gitRef: string; defaultBranch: string; branches: string[]; path: string; view: "tree" | "blob" | "commits";
}) {
  const options = branches.includes(gitRef) ? branches : [gitRef, ...branches];
  const go = (ref: string) => {
    const target = view === "commits" ? { view: "commits" as const, ref } : { view, ref, path };
    window.location.assign(gitUrl(site, target, { defaultBranch }));
  };
  return (
    <label className="inline-flex items-center gap-1.5 rounded-md border border-drive-border bg-drive-panel px-2 h-8 text-caption font-medium">
      <GitBranch className="w-3.5 h-3.5 text-drive-muted" aria-hidden="true" />
      <select aria-label="Branch" value={gitRef} onChange={(e) => go(e.target.value)} className="bg-transparent font-mono outline-hidden max-w-[40vw]" data-testid="ref-switcher">
        {options.map((b) => <option key={b} value={b}>{b}{b === defaultBranch ? " · default" : ""}</option>)}
      </select>
    </label>
  );
}

/** `/<org>/git/<repo>/deployments`: the panel's Deployments rows, full page. */
export function GitDeploymentsPage({ driveId, repo }: { driveId: string; repo: string }) {
  const [meta, setMeta] = useState<GitPanelMeta | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    apiFetch<GitPanelMeta | { exists: false }>(`/api/drives/${driveId}/git-meta?repo=${encodeURIComponent(repo)}`)
      .then((res) => { if (alive) setMeta(res.ok && res.data.exists ? res.data : null); });
    return () => { alive = false; };
  }, [driveId, repo]);
  const ainize = useAinizeProject(meta?.ainizeUrl ?? null, meta?.cloneUrl ?? null, meta?.head?.sha ?? null, !!meta?.manifest?.kind);
  const rowCls = "flex items-center gap-2 px-4 min-h-10 py-1.5 border-t border-drive-border text-caption";
  const labelCls = "text-label uppercase text-drive-muted shrink-0 w-24";
  if (meta === undefined) return <p className="text-caption text-drive-muted">Loading…</p>;
  if (meta === null) return <p className="text-caption text-drive-muted">This folder is not a repository, or you may not read it.</p>;
  return (
    <section className="rounded-xl border border-drive-border bg-drive-panel" aria-label="Deployments" data-testid="deployments-page">
      <div className="px-4 h-11 flex items-center gap-3 text-caption">
        <span className="font-medium">{meta.manifest?.name ?? repo}</span>
        {meta.manifest?.kind
          ? <span className="rounded-full bg-drive-hover px-2 py-0.5 text-label uppercase text-drive-muted">{meta.manifest.kind}</span>
          : <span className="text-drive-muted">No <code className="font-mono">ainize.json</code> — nothing for ainize to deploy.</span>}
      </div>
      {meta.manifest?.kind && <Deployments ainizeUrl={meta.ainizeUrl} ainize={ainize} rowCls={rowCls} labelCls={labelCls} />}
    </section>
  );
}
