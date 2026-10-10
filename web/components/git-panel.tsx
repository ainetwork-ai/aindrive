"use client";
// The git panel shown above a folder's listing when that folder is a git repo
// (GET /api/drives/:id/git-meta). Top to bottom: branch + HEAD · clone URL
// (copy) · Run (the project's entry — `ainize.json` `entry`, else the root's
// first runnable file) · Deployments (ainize Projects, read from the browser)
// · recent commits (toggle) · commit box (editors, dirty tree). Data loading
// for git-meta stays in the shell (one fetch per folder, refetched after a
// commit); the ainize reads live here and degrade silently.
import { useEffect, useState } from "react";
import clsx from "clsx";
import { GitBranch, GitCommitHorizontal, Copy, Check, ChevronDown, ChevronUp, ExternalLink, Rocket } from "lucide-react";
import { toast } from "sonner";
import type { GitCommit } from "@/lib/protocol";
import { apiFetch } from "@/lib/api-client";
import { relativeTime, shortSha, RUN_IDLE } from "@/lib/git-panel";
import {
  connectProjectUrl, deploymentLogUrl, deploymentTime, fetchDeployments, fetchProjectByRepo,
  type AinizeDeployment, type AinizeProject, type DeploymentStatus,
} from "@/lib/ainize-projects";
import { Button } from "@/components/ui";
import { RunActions, RunOutput, useRunner } from "./run-output";

/** What GET git-meta answers for a folder that is a repo (the route strips `method`). */
export type GitPanelMeta = {
  exists: true;
  branch: string;
  head: GitCommit | null;
  dirty: number;
  commits: GitCommit[];
  cloneUrl: string;
  ainizeUrl: string;
  /** `ainize.json` at the repo root, when present */
  manifest?: { entry: string | null; kind: string | null; name: string | null } | null;
  /** what the panel's Run row runs (manifest entry, else the root's first .py/.js/.mjs); null = nothing runnable */
  entry?: string | null;
  /** ainize project bound here through git-connect (its hook fires on push) */
  projectId?: string | null;
};

export function GitPanel({ driveId, repo, meta, canEdit, onCommitted }: {
  driveId: string;
  repo: string;
  meta: GitPanelMeta;
  canEdit: boolean;
  /** called after a successful commit, so the shell refetches git-meta (and the listing) */
  onCommitted: () => void;
}) {
  const [showLog, setShowLog] = useState(false);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const head = meta.head;

  // The project's Run row shares the per-file runner (entry path = repo-relative → drive path).
  const runner = useRunner(driveId, repo);
  const entry = meta.entry ?? null;
  const entryPath = entry === null ? null : repo ? `${repo}/${entry}` : entry;
  const run = entryPath !== null ? runner.runs[entryPath] ?? RUN_IDLE : RUN_IDLE;

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
      body: JSON.stringify({ repo, message: m }),
    });
    setCommitting(false);
    if (!res.ok) { toast.error(res.error || "commit failed"); return; }
    toast.success(`Committed ${shortSha(res.data.sha)}`);
    setMessage("");
    onCommitted();
  }

  const rowCls = "flex items-center gap-2 px-4 min-h-10 py-1.5 border-t border-drive-border text-caption";
  const labelCls = "text-label uppercase text-drive-muted shrink-0 w-20";

  return (
    <section
      className="mb-4 rounded-xl border border-drive-border bg-drive-panel text-body"
      aria-label="Git repository"
      data-testid="git-panel"
    >
      {/* 1. branch + HEAD */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 h-11 min-h-11">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <GitBranch className="w-4 h-4 text-drive-muted" aria-hidden="true" />
          <span className="font-mono text-caption">{meta.branch}</span>
        </span>
        {meta.manifest?.name && (
          <span className="text-caption text-drive-text font-medium truncate">{meta.manifest.name}</span>
        )}
        {meta.manifest?.kind && (
          <span className="rounded-full bg-drive-hover px-2 py-0.5 text-label uppercase text-drive-muted">{meta.manifest.kind}</span>
        )}
        {head ? (
          <span className="flex items-center gap-2 min-w-0 text-caption text-drive-muted">
            <span className="font-mono text-drive-text">{shortSha(head.sha)}</span>
            <span className="truncate text-drive-text">{head.subject}</span>
            <span className="whitespace-nowrap">{head.author} · {relativeTime(head.date)}</span>
          </span>
        ) : (
          <span className="text-caption text-drive-muted">No commits yet</span>
        )}
        <span className="ml-auto inline-flex items-center gap-3 text-caption">
          {meta.dirty > 0 && (
            <span className="inline-flex items-center gap-1.5 text-drive-muted" title="Uncommitted changes in the working tree">
              <span className="inline-block h-2 w-2 rounded-full bg-amber-500" aria-hidden="true" />
              {meta.dirty} changed {meta.dirty === 1 ? "file" : "files"}
            </span>
          )}
          {meta.commits.length > 0 && (
            <button
              type="button"
              className="inline-flex items-center gap-1 font-medium text-drive-muted hover:text-drive-text"
              onClick={() => setShowLog((v) => !v)}
              aria-expanded={showLog}
            >
              {meta.commits.length} {meta.commits.length === 1 ? "commit" : "commits"}
              {showLog ? <ChevronUp className="w-3 h-3" aria-hidden="true" /> : <ChevronDown className="w-3 h-3" aria-hidden="true" />}
            </button>
          )}
        </span>
      </div>

      {/* 2. clone URL */}
      <div className={rowCls}>
        <span className={labelCls}>Clone</span>
        <code className="flex-1 min-w-0 truncate font-mono text-caption text-drive-text select-all" title={meta.cloneUrl}>{meta.cloneUrl}</code>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy clone URL"
          className={clsx("inline-flex items-center gap-1 text-caption font-medium transition-colors", copied ? "text-emerald-600" : "text-drive-muted hover:text-drive-text")}
        >
          {copied ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      {/* 3. Run the project's entry */}
      <div className={rowCls} data-testid="git-panel-run">
        <span className={labelCls}>Run</span>
        {entryPath !== null && entry !== null ? (
          <>
            <code className="flex-1 min-w-0 truncate font-mono text-caption text-drive-text" title={meta.manifest?.entry ? "entry from ainize.json" : "first runnable file in the repo root"}>{entry}</code>
            <RunActions
              state={run}
              isOpen={!!runner.open[entryPath]}
              onRun={() => runner.run(entryPath)}
              onStop={() => runner.stop(entryPath)}
              onToggle={() => runner.toggle(entryPath)}
            />
            <a
              href={meta.ainizeUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-caption font-medium text-drive-muted hover:text-drive-text"
            >
              Open in ainize <ExternalLink className="w-3 h-3" aria-hidden="true" />
            </a>
          </>
        ) : (
          <span className="text-drive-muted">No entry — add <code className="font-mono">ainize.json</code> with <code className="font-mono">{"{ \"entry\": \"main.py\" }"}</code> or a .py / .js file at the root.</span>
        )}
      </div>
      {entryPath !== null && entry !== null && run.status !== "idle" && runner.open[entryPath] && (
        <div className="px-4 pb-3">
          <RunOutput state={run} entryName={entry} ainizeUrl={meta.ainizeUrl} />
        </div>
      )}

      {/* 4. Deployments (ainize Projects) */}
      <Deployments ainizeUrl={meta.ainizeUrl} cloneUrl={meta.cloneUrl} headSha={head?.sha ?? null} rowCls={rowCls} labelCls={labelCls} />

      {showLog && (
        <ol className="border-t border-drive-border divide-y divide-drive-border" aria-label="Recent commits">
          {meta.commits.map((c) => (
            <li key={c.sha} className="flex items-center gap-3 px-4 h-9 text-caption min-w-0">
              <GitCommitHorizontal className="w-3.5 h-3.5 text-drive-muted shrink-0" aria-hidden="true" />
              <span className="font-mono text-drive-muted shrink-0">{shortSha(c.sha)}</span>
              <span className="truncate text-drive-text flex-1">{c.subject}</span>
              <span className="text-drive-muted whitespace-nowrap">{c.author} · {relativeTime(c.date)}</span>
            </li>
          ))}
        </ol>
      )}

      {canEdit && meta.dirty > 0 && (
        <form
          className="flex items-center gap-2 px-4 py-2 border-t border-drive-border"
          onSubmit={(e) => { e.preventDefault(); commit(); }}
        >
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={`Commit ${meta.dirty} changed ${meta.dirty === 1 ? "file" : "files"}…`}
            aria-label="Commit message"
            maxLength={4000}
            disabled={committing}
            className="h-8 flex-1 min-w-0 rounded-md border border-drive-border bg-drive-panel px-2.5 text-caption text-drive-text placeholder:text-drive-muted focus:border-drive-accent outline-hidden"
          />
          <Button type="submit" size="sm" variant="outline" loading={committing} disabled={!message.trim()} icon={<GitCommitHorizontal className="w-3.5 h-3.5" aria-hidden="true" />}>
            Commit
          </Button>
        </form>
      )}
    </section>
  );
}

const DEPLOY_DOT: Record<DeploymentStatus, string> = {
  queued: "bg-drive-muted/70 animate-pulse",
  building: "bg-drive-muted/70 animate-pulse",
  ready: "bg-emerald-500",
  error: "bg-red-500",
};

/**
 * Vercel-style deployment rows from ainize (`GET /api/projects/by-repo`, then
 * `/api/projects/:id/deployments`), read straight from the browser (CORS for
 * aindrive's origin). No project → "Connect to ainize". Any failure → nothing.
 * Refetched when HEAD moves (a push just landed) and every 15 s while a
 * deployment is queued/building.
 */
function Deployments({ ainizeUrl, cloneUrl, headSha, rowCls, labelCls }: {
  ainizeUrl: string; cloneUrl: string; headSha: string | null; rowCls: string; labelCls: string;
}) {
  const [project, setProject] = useState<AinizeProject | null | undefined>(undefined); // undefined = loading
  const [deployments, setDeployments] = useState<AinizeDeployment[]>([]);
  const active = deployments.some((d) => d.status === "queued" || d.status === "building");

  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      const p = await fetchProjectByRepo(ainizeUrl, cloneUrl, fetch, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setProject(p);
      if (!p) { setDeployments([]); return; }
      const list = await fetchDeployments(ainizeUrl, p.id, fetch, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setDeployments(list.length ? list : p.lastDeployment ? [p.lastDeployment] : []);
      if (list.some((d) => d.status === "queued" || d.status === "building")) timer = setTimeout(load, 15_000);
    };
    load();
    return () => { ctrl.abort(); if (timer) clearTimeout(timer); };
  }, [ainizeUrl, cloneUrl, headSha]);

  if (project === undefined) return null;
  if (project === null) {
    return (
      <div className={rowCls} data-testid="git-panel-deployments">
        <span className={labelCls}>Deploy</span>
        <a
          href={connectProjectUrl(ainizeUrl, cloneUrl)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-medium text-drive-muted hover:text-drive-text"
        >
          <Rocket className="w-3.5 h-3.5" aria-hidden="true" /> ainize에 연결 (Connect to ainize) <ExternalLink className="w-3 h-3" aria-hidden="true" />
        </a>
      </div>
    );
  }
  const link = "inline-flex items-center gap-1 font-medium text-drive-muted hover:text-drive-text whitespace-nowrap";
  return (
    <div className="border-t border-drive-border" data-testid="git-panel-deployments" data-active={active || undefined}>
      <div className="flex items-center gap-2 px-4 h-9 text-caption">
        <span className={labelCls}>Deployments</span>
        <span className="text-drive-muted truncate">{project.kind} · {project.branch}</span>
        {project.url && (
          <a href={project.url} target="_blank" rel="noreferrer" className={clsx(link, "ml-auto")}>
            Project <ExternalLink className="w-3 h-3" aria-hidden="true" />
          </a>
        )}
      </div>
      {deployments.length === 0 ? (
        <div className="px-4 pb-2 text-caption text-drive-muted">No deployments yet — push to <span className="font-mono">{project.branch}</span>.</div>
      ) : (
        <ol className="divide-y divide-drive-border border-t border-drive-border" aria-label="Deployments">
          {deployments.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-4 h-9 text-caption min-w-0" data-status={d.status}>
              <span
                role="status"
                aria-label={d.status}
                title={d.status}
                className={clsx("inline-block h-2 w-2 shrink-0 rounded-full", DEPLOY_DOT[d.status] ?? "bg-drive-border")}
              />
              <span className="font-mono text-drive-text shrink-0">{shortSha(d.sha || "")}</span>
              <span className="text-drive-muted truncate flex-1">
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
