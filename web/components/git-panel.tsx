"use client";
// The git panel shown above a folder's listing when that folder is a git repo
// (GET /api/drives/:id/git-meta). Top to bottom: branch + HEAD + Push/Pull ·
// clone URL (copy) · Run (the project's entry — `ainize.json` `entry`, else the
// root's first runnable file) · Deployments (ainize Projects, read from the
// browser) · recent commits (toggle) · Source Control (VS Code-like: staged /
// changes / untracked rows with M A D U badges, +/− per row, Stage all, Discard,
// and the commit box — editors only). The folder is the repo's WORKING COPY
// (lib/git-paths.ts): a commit lands there; Push moves it into the bare remote
// and is what deploys (POST git-sc). Data loading for git-meta stays in the
// shell (one fetch per folder, refetched after every action); the ainize reads
// live here and degrade silently.
// Metadata and Run start collapsed so the file listing stays visible. Their
// separate disclosures preserve the current form and running output.
import { useEffect, useId, useState } from "react";
import clsx from "clsx";
import { GitBranch, GitCommitHorizontal, Copy, Check, ChevronDown, ChevronUp, ExternalLink, ArrowUp, ArrowDown, Plus, Minus, Undo2 } from "lucide-react";
import { toast } from "sonner";
import type { GitChange, GitCommit, GitLayout, GitStatus } from "@/lib/protocol";
import { apiFetch } from "@/lib/api-client";
import { relativeTime, shortSha, RUN_IDLE } from "@/lib/git-panel";
import { deploymentLogUrl, deploymentTime, type DeploymentStatus } from "@/lib/ainize-projects";
import { inputsStorageKey, inputsToEnv, missingRequired, parseManifestInputs, type ManifestInput } from "@/lib/run-inputs";
import type { AinizeProjectState } from "./use-ainize-project";
import { Button } from "@/components/ui";
import { RunActions, RunDot, RunOutput, useRunner } from "./run-output";

/** What GET git-meta answers for a folder that is a repo (the route strips `method`). */
export type GitPanelMeta = {
  exists: true;
  branch: string;
  head: GitCommit | null;
  dirty: number;
  commits: GitCommit[];
  cloneUrl: string;
  ainizeUrl: string;
  /** `ainize.json` at the repo root, when present (`inputs`: the fields the Run row asks for, lib/run-inputs.ts) */
  manifest?: { entry: string | null; kind: string | null; name: string | null; inputs?: ManifestInput[] } | null;
  /** what the panel's Run row runs by default (manifest entry, else the root's first .py/.js/.mjs); null = nothing runnable */
  entry?: string | null;
  /** every runnable file at the repo root — the Run row's choices */
  runnable?: string[];
  /** ainize project bound here (its hook fires on push) */
  projectId?: string | null;
  /** working copy with its bare remote, a legacy non-bare repo, or bare (lib/git-paths.ts) */
  layout?: GitLayout;
  ahead?: number;
  behind?: number;
  /** agent `git-status` of the working copy — the Source Control lists; null when it could not be read */
  status?: Omit<GitStatus, "method"> | null;
};

/** Pretty-URL links (lib/git-urls.ts) the panel uses when the repo is shown at `/<org>/git/<repo>`; absent on /d/<id>. */
export type GitPanelUrls = { commit: (sha: string) => string; commits: string; deployments: string };

export function GitPanel({ driveId, repo, meta, ainize, canEdit, onCommitted, urls, onOpenFile }: {
  driveId: string;
  repo: string;
  meta: GitPanelMeta;
  urls?: GitPanelUrls;
  /** a Source Control row was clicked: open that file (drive path) in the viewer */
  onOpenFile?: (path: string) => void;
  /** the bound ainize project (components/use-ainize-project.ts), shared with the file rows */
  ainize: AinizeProjectState;
  canEdit: boolean;
  /** called after a successful commit, so the shell refetches git-meta (and the listing) */
  onCommitted: () => void;
}) {
  const [showLog, setShowLog] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const head = meta.head;
  const status = meta.status ?? null;
  const staged = status?.staged ?? [];
  const changes = [...(status?.unstaged ?? []), ...(status?.untracked ?? [])];
  const changeCount = staged.length + changes.length;
  const isWorkingCopy = meta.layout === "working-copy";
  const ahead = meta.ahead ?? status?.ahead ?? 0;
  const behind = meta.behind ?? status?.behind ?? 0;
  // VS Code's default: with nothing staged, the commit takes everything; with a staged set, only that.
  const [commitAll, setCommitAll] = useState(true);
  const effectiveAll = staged.length === 0 ? true : commitAll;

  async function sc(action: "stage" | "unstage" | "discard" | "push" | "pull", paths?: string[]) {
    setBusy(action);
    const res = await apiFetch<{ ok: true; moved?: boolean }>(`/api/drives/${driveId}/git-sc`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo, action, ...(paths ? { paths } : {}) }),
    });
    setBusy(null);
    if (!res.ok) { toast.error(res.error || `${action} failed`); return false; }
    if (action === "push") toast.success(res.data.moved ? "Pushed — the remote is up to date" : "Nothing to push");
    if (action === "pull") toast.success("Pulled (fast-forward)");
    onCommitted();
    return true;
  }
  const discard = (paths: string[]) => {
    const what = paths.length === 1 ? `"${paths[0]}"` : `${paths.length} files`;
    if (!confirm(`Discard changes to ${what}? Edits are lost; new files are deleted.`)) return;
    void sc("discard", paths);
  };

  // The project's Run row shares the per-file runner (entry path = repo-relative → drive path). The row runs
  // the manifest's entry by default; any runnable file at the root can be picked instead.
  const runner = useRunner(driveId, repo);
  const runOptionsId = useId();
  const [runExpanded, setRunExpanded] = useState(false);
  useEffect(() => {
    setRunExpanded(false);
    setDetailsExpanded(false);
  }, [driveId, repo]);
  const [runTarget, setRunTarget] = useState<"working-tree" | "commit" | "deployed">("working-tree");
  const [runSha, setRunSha] = useState("");
  const selectedSha = runSha || meta.head?.sha || "";
  type Source = { sha: string; manifest: { entry?: string; inputs?: Record<string, unknown> } };
  const sourceKey = JSON.stringify([driveId, repo, runTarget, runTarget === 'commit' ? selectedSha : ainize.project?.activeCommit]);
  const [sourceResult, setSourceResult] = useState<{ key: string; data?: Source; error?: string } | null>(null);
  const source = sourceResult?.key === sourceKey ? sourceResult.data : undefined;
  const sourceError = sourceResult?.key === sourceKey ? sourceResult.error : undefined;
  useEffect(() => {
    if (runTarget === 'working-tree') return;
    const controller = new AbortController();
    const query = new URLSearchParams({ repo, target: runTarget, ...(runTarget === 'commit' ? { sha: selectedSha } : {}) });
    void apiFetch<Source>(`/api/drives/${encodeURIComponent(driveId)}/run?${query}`, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      setSourceResult(result.ok ? { key: sourceKey, data: result.data } : { key: sourceKey, error: result.error });
    });
    return () => controller.abort();
  }, [driveId, repo, runTarget, selectedSha, sourceKey]);
  const choices = runTarget === 'working-tree'
    ? Array.from(new Set([...(meta.entry ? [meta.entry] : []), ...(meta.runnable ?? [])]))
    : source?.manifest.entry ? [source.manifest.entry] : [];
  const [picked, setPicked] = useState<string | null>(null);
  const entry = picked && choices.includes(picked) ? picked : choices[0] ?? meta.entry ?? null;
  const entryPath = entry === null ? null : repo ? `${repo}/${entry}` : entry;
  const run = entryPath !== null ? runner.runs[entryPath] ?? RUN_IDLE : RUN_IDLE;
  const inputs = runTarget === 'working-tree' ? meta.manifest?.inputs ?? [] : parseManifestInputs(source?.manifest.inputs);
  const { values, setValue } = useRunInputs(driveId, repo, inputs);
  const startRun = () => {
    if (!entryPath) return;
    if (runTarget !== "working-tree" && !source) { toast.error(sourceError ?? "Loading repository version"); return; }
    const missing = missingRequired(inputs, values);
    if (missing.length) { toast.error(`Fill in ${missing.join(", ")}`); return; }
    if (runTarget !== "working-tree" && !ainize.project) { toast.error("Push to bind this repository before running a version"); return; }
    if (runTarget === "commit" && !selectedSha) { toast.error("Select a commit"); return; }
    if (runTarget === "deployed" && !ainize.project?.activeCommit) { toast.error("No successful deployment is available"); return; }
    setRunExpanded(true);
    runner.run(entryPath, inputsToEnv(inputs, values), runTarget === "working-tree" ? { target: "working-tree" } : { target: "commit", sha: source!.sha });
  };

  async function copy() {
    try {
      await navigator.clipboard.writeText(meta.cloneUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { toast.error("Couldn't copy — select the URL and copy it"); }
  }

  async function commit() {
    const m = message.trim();
    if (!m) { toast.error("Write a commit message"); return; }
    setCommitting(true);
    const res = await apiFetch<{ sha: string }>(`/api/drives/${driveId}/git-commit`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo, message: m, all: effectiveAll }),
    });
    setCommitting(false);
    if (!res.ok) { toast.error(res.error || "commit failed"); return; }
    toast.success(isWorkingCopy ? `Committed ${shortSha(res.data.sha)} — Push to deploy` : `Committed ${shortSha(res.data.sha)}`);
    setMessage("");
    onCommitted();
  }

  const rowCls = "flex flex-wrap sm:flex-nowrap items-center gap-2 px-4 min-h-11 sm:min-h-10 py-2 sm:py-1.5 border-t border-drive-border text-caption";
  const labelCls = "text-label uppercase text-drive-muted shrink-0 w-full sm:w-24";

  return (
    <section
      className="mb-4 rounded-xl border border-drive-border bg-drive-panel text-body"
      aria-label="Git repository"
      data-testid="git-panel"
    >
      {/* 1. branch + HEAD */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 min-h-11">
        <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 font-medium">
          <GitBranch className="w-4 h-4 text-drive-muted" aria-hidden="true" />
          <span className="font-mono text-caption truncate" title={meta.branch}>{meta.branch}</span>
        </span>
        {meta.manifest?.name && (
          <span className="text-caption text-drive-text font-medium truncate min-w-0 max-w-full">{meta.manifest.name}</span>
        )}
        {meta.manifest?.kind && (
          <span className="rounded-full bg-drive-hover px-2 py-0.5 text-label uppercase text-drive-muted">{meta.manifest.kind}</span>
        )}
        {head ? (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0 w-full sm:w-auto sm:flex-1 text-caption text-drive-muted">
            <span className="font-mono text-drive-text">{shortSha(head.sha)}</span>
            {detailsExpanded && <span className="truncate min-w-0 flex-1 text-drive-text" title={head.subject}>{head.subject}</span>}
            {detailsExpanded && <span className="w-full sm:w-auto truncate">{head.author} · {relativeTime(head.date)}</span>}
          </span>
        ) : (
          <span className="text-caption text-drive-muted">No commits yet</span>
        )}
        <span className="ml-auto inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-caption">
          {meta.dirty > 0 && (
            <span className="inline-flex items-center gap-1.5 text-drive-muted" title="Uncommitted changes in the working copy">
              <span className="inline-block h-2 w-2 rounded-full bg-amber-500" aria-hidden="true" />
              {meta.dirty} changed {meta.dirty === 1 ? "file" : "files"}
            </span>
          )}
          {isWorkingCopy && canEdit && (ahead > 0 || behind > 0) && (
            <span className="inline-flex items-center gap-2" data-testid="git-panel-sync">
              {ahead > 0 && (
                <Button size="sm" variant="filled" loading={busy === "push"} onClick={() => sc("push")} icon={<ArrowUp className="w-3.5 h-3.5" aria-hidden="true" />} title="Push the committed changes into the remote — this deploys">
                  Push {ahead}
                </Button>
              )}
              {behind > 0 && (
                <Button size="sm" variant="outline" loading={busy === "pull"} disabled={meta.dirty > 0} onClick={() => sc("pull")} icon={<ArrowDown className="w-3.5 h-3.5" aria-hidden="true" />}
                  title={meta.dirty > 0 ? "Commit or discard your changes first — a pull never overwrites them" : "Fast-forward the working copy to the remote"}>
                  Pull {behind}
                </Button>
              )}
            </span>
          )}
          {isWorkingCopy && canEdit && ahead === 0 && behind === 0 && meta.dirty === 0 && head && (
            <span className="text-drive-muted" title="The working copy and the remote are the same">up to date</span>
          )}
          {detailsExpanded && meta.commits.length > 0 && (
            <button
              type="button"
              className="min-h-11 sm:min-h-0 inline-flex items-center gap-1 font-medium text-drive-muted hover:text-drive-text"
              onClick={() => setShowLog((v) => !v)}
              aria-expanded={showLog}
            >
              {meta.commits.length} {meta.commits.length === 1 ? "commit" : "commits"}
              {showLog ? <ChevronUp className="w-3 h-3" aria-hidden="true" /> : <ChevronDown className="w-3 h-3" aria-hidden="true" />}
            </button>
          )}
          {detailsExpanded && urls && (
            <a href={urls.commits} className="min-h-11 sm:min-h-0 inline-flex items-center font-medium text-drive-muted hover:text-drive-text" data-testid="git-panel-history">History</a>
          )}
          <button type="button" aria-label="Repository details" aria-expanded={detailsExpanded} onClick={() => setDetailsExpanded((open) => !open)} className="inline-flex min-h-11 items-center gap-1 text-caption font-medium text-drive-muted hover:text-drive-text">
            Details
            {detailsExpanded ? <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />}
          </button>
        </span>
      </div>

      {/* 2. clone URL */}
      {detailsExpanded && <div className={rowCls}>
        <span className={labelCls}>Clone</span>
        <code className="flex-1 min-w-0 truncate font-mono text-caption text-drive-text select-all" title={meta.cloneUrl}>{meta.cloneUrl}</code>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy clone URL"
          className={clsx("min-h-11 sm:min-h-0 shrink-0 inline-flex items-center gap-1 text-caption font-medium transition-colors", copied ? "text-emerald-600" : "text-drive-muted hover:text-drive-text")}
        >
          {copied ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>}

      {meta.layout === "legacy" && (
        <div className={clsx(rowCls, "text-amber-800 bg-amber-50")} data-testid="git-panel-legacy" role="note">
          <span className={labelCls}>Layout</span>
          <span>
            Legacy repository (no bare remote): clone works, push and Pull do not. Run <code className="font-mono">scripts/migrate-repo-layout.mjs</code> on the drive to split it into <code className="font-mono">{repo}.git</code> + this working copy.
          </span>
        </div>
      )}

      {/* 3. Run the project's entry */}
      <button
        type="button"
        aria-label="Run options"
        aria-expanded={runExpanded}
        aria-controls={runOptionsId}
        onClick={() => setRunExpanded((open) => !open)}
        className="flex w-full min-w-0 items-center gap-3 border-t border-drive-border px-4 min-h-11 text-caption text-left hover:bg-drive-hover"
      >
        <span className="text-label uppercase text-drive-muted shrink-0">Run</span>
        <span className="min-w-0 flex-1 truncate font-mono text-drive-text">{entry ?? 'Execution options'}</span>
        {run.status !== 'idle' && <RunDot status={run.status} />}
        {runExpanded ? <ChevronUp className="w-4 h-4 shrink-0 text-drive-muted" aria-hidden="true" /> : <ChevronDown className="w-4 h-4 shrink-0 text-drive-muted" aria-hidden="true" />}
      </button>
      <div id={runOptionsId} hidden={!runExpanded}>
      {runTarget !== 'working-tree' && <p className="px-4 py-2 text-caption text-drive-muted" role={sourceError ? 'alert' : 'status'}>{sourceError ?? (source ? `Commit ${shortSha(source.sha)}` : 'Loading repository version')}</p>}
      <div className={clsx(rowCls, "sm:flex-wrap [&>span:last-of-type]:min-h-11 sm:[&>span:last-of-type]:min-h-0 [&_button]:min-h-11 sm:[&_button]:min-h-0")} data-testid="git-panel-run">
        {entryPath !== null && entry !== null ? (
          <>
            {choices.length > 1 ? (
              <select
                aria-label="File to run"
                value={entry}
                onChange={(e) => setPicked(e.target.value)}
                className="w-full sm:w-auto sm:flex-1 min-w-0 h-11 sm:h-auto truncate rounded border border-drive-border bg-drive-panel px-2 sm:px-1.5 py-2 sm:py-0.5 font-mono text-base sm:text-caption text-drive-text"
                title={entry === meta.manifest?.entry ? "entry from ainize.json" : "a runnable file in the repo root"}
              >
                {choices.map((c) => <option key={c} value={c}>{c}{c === meta.manifest?.entry ? " · entry" : ""}</option>)}
              </select>
            ) : (
              <code className="flex-1 min-w-0 truncate font-mono text-caption text-drive-text" title={meta.manifest?.entry ? "entry from ainize.json" : "first runnable file in the repo root"}>{entry}</code>
            )}
            <select aria-label="Run version" value={runTarget} onChange={(e) => setRunTarget(e.target.value as typeof runTarget)} className="w-full sm:w-auto min-w-0 h-11 sm:h-auto rounded border border-drive-border bg-drive-panel px-2 py-2 sm:py-0.5 text-base sm:text-caption">
              <option value="working-tree">Working files · includes edits</option>
              <option value="commit" disabled={!ainize.project}>Selected commit</option>
              <option value="deployed" disabled={!ainize.project?.activeCommit}>Deployed version{ainize.project?.activeCommit ? ` · ${shortSha(ainize.project.activeCommit)}` : ""}</option>
            </select>
            {runTarget === "commit" && <select aria-label="Commit to run" value={selectedSha} onChange={(e) => setRunSha(e.target.value)} className="w-full sm:w-auto sm:max-w-48 min-w-0 h-11 sm:h-auto rounded border border-drive-border bg-drive-panel px-2 py-2 sm:py-0.5 font-mono text-base sm:text-caption">
              {meta.commits.map((commit) => <option key={commit.sha} value={commit.sha}>{shortSha(commit.sha)} · {commit.subject}</option>)}
            </select>}
            <RunActions
              state={run}
              isOpen={!!runner.open[entryPath]}
              onRun={startRun}
              onStop={() => runner.stop(entryPath)}
              onToggle={() => runner.toggle(entryPath)}
            />
            {ainize.projectUrl && (
              <a
                href={ainize.projectUrl}
                target="_blank"
                rel="noreferrer"
                className="min-h-11 sm:min-h-0 inline-flex items-center gap-1 text-caption font-medium text-drive-muted hover:text-drive-text"
              >
                Open in ainize <ExternalLink className="w-3 h-3" aria-hidden="true" />
              </a>
            )}
          </>
        ) : (
          <span className="text-drive-muted">No entry — add <code className="font-mono">ainize.json</code> with <code className="font-mono">{"{ \"entry\": \"main.py\" }"}</code> or a .py / .js file at the root.</span>
        )}
      </div>
      {entryPath !== null && inputs.length > 0 && (
        <div className="grid gap-2 px-4 pb-3 sm:grid-cols-2" data-testid="git-panel-inputs">
          {inputs.map((i) => <InputField key={i.name} input={i} value={values[i.name] ?? ""} onChange={(v) => setValue(i.name, v)} />)}
        </div>
      )}
      {entryPath !== null && entry !== null && run.status !== "idle" && runner.open[entryPath] && (
        <div className="px-4 pb-3">
          <RunOutput state={run} entryName={entry} openUrl={ainize.projectUrl} />
        </div>
      )}
      </div>

      {/* 4. Deployments (ainize Projects) — only for a repo that declares how it deploys (ainize.json). A repo
          without a manifest has nothing for ainize to build, so nothing is shown. With one and no project yet, the
          next push binds and deploys it (lib/git-project-hooks.ts) — there is no step to take. */}
      {detailsExpanded && meta.manifest?.kind && (
        <Deployments ainizeUrl={meta.ainizeUrl} ainize={ainize} rowCls={rowCls} labelCls={labelCls} allHref={urls?.deployments} />
      )}

      {detailsExpanded && showLog && (
        <ol className="border-t border-drive-border divide-y divide-drive-border" aria-label="Recent commits">
          {meta.commits.map((c) => (
            <li key={c.sha} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 min-h-11 sm:min-h-9 py-2 text-caption min-w-0">
              <GitCommitHorizontal className="w-3.5 h-3.5 text-drive-muted shrink-0" aria-hidden="true" />
              {urls
                ? <a href={urls.commit(c.sha)} className="font-mono text-drive-muted shrink-0 hover:underline">{shortSha(c.sha)}</a>
                : <span className="font-mono text-drive-muted shrink-0">{shortSha(c.sha)}</span>}
              {urls
                ? <a href={urls.commit(c.sha)} className="truncate text-drive-text flex-1 hover:underline">{c.subject}</a>
                : <span className="truncate text-drive-text flex-1">{c.subject}</span>}
              <span className="w-full sm:w-auto text-drive-muted truncate">{c.author} · {relativeTime(c.date)}</span>
            </li>
          ))}
        </ol>
      )}

      {/* 5. Source Control (editors): staged · changes, like VS Code; rows open the file */}
      {canEdit && status && changeCount > 0 && (
        <section className="border-t border-drive-border" aria-label="Source control" data-testid="git-panel-changes">
          {staged.length > 0 && (
            <ChangeList
              title="Staged Changes" items={staged} repo={repo} onOpen={onOpenFile} busy={!!busy}
              rowAction={{ label: "Unstage", icon: <Minus className="w-3.5 h-3.5" aria-hidden="true" />, run: (p) => void sc("unstage", [p]) }}
              headerActions={<button type="button" className="text-caption font-medium text-drive-muted hover:text-drive-text" disabled={!!busy} onClick={() => void sc("unstage", staged.map((f) => f.path))}>Unstage all</button>}
            />
          )}
          {changes.length > 0 && (
            <ChangeList
              title="Changes" items={changes} repo={repo} onOpen={onOpenFile} busy={!!busy}
              rowAction={{ label: "Stage", icon: <Plus className="w-3.5 h-3.5" aria-hidden="true" />, run: (p) => void sc("stage", [p]) }}
              rowDiscard={(p) => discard([p])}
              headerActions={(
                <>
                  <button type="button" className="text-caption font-medium text-drive-muted hover:text-drive-text" disabled={!!busy} onClick={() => void sc("stage", changes.map((f) => f.path))}>Stage all</button>
                  <button type="button" className="text-caption font-medium text-red-600 hover:text-red-700" disabled={!!busy} onClick={() => discard(changes.map((f) => f.path))}>Discard all</button>
                </>
              )}
            />
          )}
        </section>
      )}

      {canEdit && meta.dirty > 0 && (
        <form
          className="flex flex-wrap items-center gap-2 px-4 py-2 border-t border-drive-border"
          onSubmit={(e) => { e.preventDefault(); commit(); }}
        >
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={effectiveAll ? `Commit ${meta.dirty} changed ${meta.dirty === 1 ? "file" : "files"}…` : `Commit ${staged.length} staged ${staged.length === 1 ? "file" : "files"}…`}
            aria-label="Commit message"
            maxLength={4000}
            disabled={committing}
            className="h-11 sm:h-8 basis-full sm:basis-auto flex-1 min-w-0 rounded-md border border-drive-border bg-drive-panel px-2.5 text-base sm:text-caption text-drive-text placeholder:text-drive-muted focus:border-drive-accent outline-hidden"
          />
          <Button type="submit" size="sm" variant="outline" loading={committing} disabled={!message.trim()} icon={<GitCommitHorizontal className="w-3.5 h-3.5" aria-hidden="true" />}>
            Commit
          </Button>
          {staged.length > 0 && (
            <label className="inline-flex items-center gap-1.5 text-caption text-drive-muted whitespace-nowrap">
              <input type="checkbox" checked={commitAll} onChange={(e) => setCommitAll(e.target.checked)} /> stage all &amp; commit
            </label>
          )}
        </form>
      )}
    </section>
  );
}

/**
 * The answers to a manifest's `inputs` (lib/run-inputs.ts): one value per field, prefilled with the
 * default, the last answers remembered per repo in this browser. Shared by the panel's Run row and
 * the file viewer's ▶ Run (components/viewer.tsx), so both ask the same questions and remember the
 * same answers.
 */
export function useRunInputs(driveId: string, repo: string, inputs: ManifestInput[]) {
  const [values, setValues] = useState<Record<string, string>>({});
  // keyed by content, not identity: callers pass `manifest?.inputs ?? []`, a fresh array each render
  const inputsKey = JSON.stringify(inputs);
  useEffect(() => {
    let saved: Record<string, string> = {};
    try { saved = JSON.parse(localStorage.getItem(inputsStorageKey(driveId, repo)) ?? "{}") as Record<string, string>; } catch {}
    const next: Record<string, string> = {};
    for (const i of inputs) next[i.name] = typeof saved[i.name] === "string" ? saved[i.name] : i.default ?? (i.type === "boolean" ? "false" : "");
    setValues(next);
  }, [driveId, repo, inputsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const setValue = (name: string, v: string) => {
    setValues((prev) => {
      const next = { ...prev, [name]: v };
      try { localStorage.setItem(inputsStorageKey(driveId, repo), JSON.stringify(next)); } catch {}
      return next;
    });
  };
  return { values, setValue };
}

const BADGE: Record<string, { label: string; cls: string; title: string }> = {
  M: { label: "M", cls: "text-amber-600", title: "modified" },
  A: { label: "A", cls: "text-emerald-600", title: "added" },
  D: { label: "D", cls: "text-red-600", title: "deleted" },
  R: { label: "R", cls: "text-sky-600", title: "renamed" },
  C: { label: "C", cls: "text-fuchsia-600", title: "conflict" },
  U: { label: "U", cls: "text-emerald-600", title: "untracked" },
  T: { label: "T", cls: "text-amber-600", title: "type changed" },
};

/** One Source Control list (Staged Changes / Changes): rows with a status badge, +/− and discard, like VS Code. */
function ChangeList({ title, items, repo, onOpen, rowAction, rowDiscard, headerActions, busy }: {
  title: string; items: GitChange[]; repo: string; onOpen?: (path: string) => void; busy: boolean;
  rowAction: { label: string; icon: React.ReactNode; run: (path: string) => void };
  rowDiscard?: (path: string) => void;
  headerActions: React.ReactNode;
}) {
  return (
    <div data-testid={`git-changes-${title.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="flex flex-wrap items-center gap-3 px-4 min-h-11 sm:min-h-8 py-1 text-label uppercase text-drive-muted">
        <span>{title}</span>
        <span className="rounded-full bg-drive-hover px-1.5 text-drive-text normal-case">{items.length}</span>
        <span className="ml-auto inline-flex items-center gap-3 normal-case">{headerActions}</span>
      </div>
      <ul className="divide-y divide-drive-border/60">
        {items.map((f) => {
          const b = BADGE[f.status] ?? { label: f.status, cls: "text-drive-muted", title: f.status };
          const drivePath = repo ? `${repo}/${f.path}` : f.path;
          return (
            <li key={f.path} className="group flex items-center gap-2 px-4 min-h-11 sm:min-h-8 text-caption min-w-0 hover:bg-drive-hover" data-status={f.status}>
              <button type="button" className="flex-1 min-w-0 text-left truncate font-mono text-drive-text hover:underline disabled:no-underline" onClick={() => onOpen?.(drivePath)} disabled={!onOpen || f.status === "D"} title={f.path}>
                {f.path}
              </button>
              <span className={clsx("font-mono font-semibold w-4 text-center", b.cls)} title={b.title} aria-label={b.title}>{b.label}</span>
              <span className="inline-flex items-center gap-1">
                {rowDiscard && (
                  <button type="button" className="rounded min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 p-1 inline-flex items-center justify-center text-drive-muted hover:text-red-600 hover:bg-white" onClick={() => rowDiscard(f.path)} disabled={busy} aria-label={`Discard changes to ${f.path}`} title="Discard changes">
                    <Undo2 className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                )}
                <button type="button" className="rounded min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 p-1 inline-flex items-center justify-center text-drive-muted hover:text-drive-text hover:bg-white" onClick={() => rowAction.run(f.path)} disabled={busy} aria-label={`${rowAction.label} ${f.path}`} title={rowAction.label}>
                  {rowAction.icon}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const DEPLOY_DOT: Record<DeploymentStatus, string> = {
  queued: "bg-drive-muted/70 animate-pulse",
  building: "bg-drive-muted/70 animate-pulse",
  ready: "bg-emerald-500",
  error: "bg-red-500",
};

/** One field of the manifest's `inputs`: text / select / checkbox / number, labelled by `description`. */
export function InputField({ input, value, onChange }: { input: ManifestInput; value: string; onChange: (v: string) => void }) {
  const id = `run-input-${input.name}`;
  const field = "w-full min-w-0 min-h-11 sm:min-h-0 text-base sm:text-caption rounded border border-drive-border bg-drive-panel px-2 py-2 sm:py-1 text-drive-text";
  const label = <label htmlFor={id} className="text-label text-drive-muted break-words" title={input.name}>{input.description ?? input.name}{input.required ? " *" : ""}</label>;
  if (input.type === "boolean") {
    return (
      <div className="flex items-center gap-2 min-h-11 text-caption">
        <input id={id} type="checkbox" checked={value === "true"} onChange={(e) => onChange(e.target.checked ? "true" : "false")} />
        {label}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      {label}
      {input.type === "choice" ? (
        <select id={id} className={field} value={value} onChange={(e) => onChange(e.target.value)}>
          {(input.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input id={id} type={input.type === "number" ? "number" : "text"} className={field} value={value} onChange={(e) => onChange(e.target.value)} placeholder={input.default ?? ""} />
      )}
    </div>
  );
}

/**
 * Vercel-style deployment rows from ainize (components/use-ainize-project.ts).
 * No project yet → one quiet line: the next push binds and deploys the repo
 * (lib/git-project-hooks.ts autoBindProject). Any failure → nothing.
 */
export function Deployments({ ainizeUrl, ainize, rowCls, labelCls, allHref }: {
  ainizeUrl: string; ainize: AinizeProjectState; rowCls: string; labelCls: string;
  /** the full-page `/<org>/git/<repo>/deployments` (repo pages only) */
  allHref?: string;
}) {
  const { project, deployments, active } = ainize;
  if (project === undefined) return null;
  if (project === null) {
    return (
      <div className={rowCls} data-testid="git-panel-deployments" data-project="none">
        <span className={labelCls}>Deploy</span>
        <span className="text-drive-muted">다음 push에서 자동 배포됩니다 · deploys on the next push</span>
      </div>
    );
  }
  const link = "min-h-11 sm:min-h-0 shrink-0 inline-flex items-center gap-1 font-medium text-drive-muted hover:text-drive-text whitespace-nowrap";
  return (
    <div className="border-t border-drive-border" data-testid="git-panel-deployments" data-active={active || undefined}>
      <div className="flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-1 px-4 min-h-11 sm:min-h-9 py-2 sm:py-0 text-caption">
        <span className={labelCls}>Deployments</span>
        <span className="text-drive-muted min-w-0 truncate">{project.kind} · {project.branch}</span>
        {allHref && <a href={allHref} className={clsx(link, "sm:ml-auto")}>All deployments</a>}
        {project.url && (
          <a href={project.url} target="_blank" rel="noreferrer" className={clsx(link, !allHref && "ml-auto")}>
            Project <ExternalLink className="w-3 h-3" aria-hidden="true" />
          </a>
        )}
      </div>
      {deployments.length === 0 ? (
        <div className="px-4 pb-2 text-caption text-drive-muted">No deployments yet — push to <span className="font-mono">{project.branch}</span>.</div>
      ) : (
        <ol className="divide-y divide-drive-border border-t border-drive-border" aria-label="Deployments">
          {deployments.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 min-h-11 sm:min-h-9 py-2 text-caption min-w-0" data-status={d.status}>
              <span
                role="status"
                aria-label={d.status}
                title={d.status}
                className={clsx("inline-block h-2 w-2 shrink-0 rounded-full", DEPLOY_DOT[d.status] ?? "bg-drive-border")}
              />
              <span className="font-mono text-drive-text shrink-0">{shortSha(d.sha || "")}</span>
              <span className="text-drive-muted min-w-0 break-words flex-1">
                {d.status}{d.status === "error" && d.exitCode !== undefined && d.exitCode !== null ? ` (exit ${d.exitCode})` : ""}
                {deploymentTime(d) ? ` · ${relativeTime(deploymentTime(d))}` : ""}
              </span>
              <a href={project.url || deploymentLogUrl(ainizeUrl, d)} target="_blank" rel="noreferrer" className={link}>Inspect</a>
              {d.outputUrl && d.status === "ready" && (
                <a href={d.outputUrl} target="_blank" rel="noreferrer" className={link}>Visit <ExternalLink className="w-3 h-3" aria-hidden="true" /></a>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
