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
import { GitBranch, GitCommitHorizontal, Copy, Check, ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import type { GitCommit } from "@/lib/protocol";
import { apiFetch } from "@/lib/api-client";
import { relativeTime, shortSha, RUN_IDLE } from "@/lib/git-panel";
import { deploymentLogUrl, deploymentTime, type DeploymentStatus } from "@/lib/ainize-projects";
import { inputsStorageKey, inputsToEnv, missingRequired, type ManifestInput } from "@/lib/run-inputs";
import type { AinizeProjectState } from "./use-ainize-project";
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
  /** `ainize.json` at the repo root, when present (`inputs`: the fields the Run row asks for, lib/run-inputs.ts) */
  manifest?: { entry: string | null; kind: string | null; name: string | null; inputs?: ManifestInput[] } | null;
  /** what the panel's Run row runs by default (manifest entry, else the root's first .py/.js/.mjs); null = nothing runnable */
  entry?: string | null;
  /** every runnable file at the repo root — the Run row's choices */
  runnable?: string[];
  /** ainize project bound here (its hook fires on push) */
  projectId?: string | null;
};

export function GitPanel({ driveId, repo, meta, ainize, canEdit, onCommitted }: {
  driveId: string;
  repo: string;
  meta: GitPanelMeta;
  /** the bound ainize project (components/use-ainize-project.ts), shared with the file rows */
  ainize: AinizeProjectState;
  canEdit: boolean;
  /** called after a successful commit, so the shell refetches git-meta (and the listing) */
  onCommitted: () => void;
}) {
  const [showLog, setShowLog] = useState(false);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const head = meta.head;

  // The project's Run row shares the per-file runner (entry path = repo-relative → drive path). The row runs
  // the manifest's entry by default; any runnable file at the root can be picked instead.
  const runner = useRunner(driveId, repo);
  const choices = Array.from(new Set([...(meta.entry ? [meta.entry] : []), ...(meta.runnable ?? [])]));
  const [picked, setPicked] = useState<string | null>(null);
  const entry = picked && choices.includes(picked) ? picked : meta.entry ?? choices[0] ?? null;
  const entryPath = entry === null ? null : repo ? `${repo}/${entry}` : entry;
  const run = entryPath !== null ? runner.runs[entryPath] ?? RUN_IDLE : RUN_IDLE;
  // Inputs (ainize.json `inputs`, the workflow_dispatch shape): one field each, prefilled with the default,
  // the last answers remembered per repo in this browser, sent as INPUT_<NAME> env with the run.
  const inputs = meta.manifest?.inputs ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    let saved: Record<string, string> = {};
    try { saved = JSON.parse(localStorage.getItem(inputsStorageKey(driveId, repo)) ?? "{}") as Record<string, string>; } catch {}
    const next: Record<string, string> = {};
    for (const i of inputs) next[i.name] = typeof saved[i.name] === "string" ? saved[i.name] : i.default ?? (i.type === "boolean" ? "false" : "");
    setValues(next);
  }, [driveId, repo, meta.manifest]); // eslint-disable-line react-hooks/exhaustive-deps
  const setValue = (name: string, v: string) => {
    setValues((prev) => {
      const next = { ...prev, [name]: v };
      try { localStorage.setItem(inputsStorageKey(driveId, repo), JSON.stringify(next)); } catch {}
      return next;
    });
  };
  const startRun = () => {
    if (!entryPath) return;
    const missing = missingRequired(inputs, values);
    if (missing.length) { toast.error(`Fill in ${missing.join(", ")}`); return; }
    runner.run(entryPath, inputsToEnv(inputs, values));
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
            {choices.length > 1 ? (
              <select
                aria-label="File to run"
                value={entry}
                onChange={(e) => setPicked(e.target.value)}
                className="flex-1 min-w-0 truncate rounded border border-drive-border bg-drive-panel px-1.5 py-0.5 font-mono text-caption text-drive-text"
                title={entry === meta.manifest?.entry ? "entry from ainize.json" : "a runnable file in the repo root"}
              >
                {choices.map((c) => <option key={c} value={c}>{c}{c === meta.manifest?.entry ? " · entry" : ""}</option>)}
              </select>
            ) : (
              <code className="flex-1 min-w-0 truncate font-mono text-caption text-drive-text" title={meta.manifest?.entry ? "entry from ainize.json" : "first runnable file in the repo root"}>{entry}</code>
            )}
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
                className="inline-flex items-center gap-1 text-caption font-medium text-drive-muted hover:text-drive-text"
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

      {/* 4. Deployments (ainize Projects) — only for a repo that declares how it deploys (ainize.json). A repo
          without a manifest has nothing for ainize to build, so nothing is shown. With one and no project yet, the
          next push binds and deploys it (lib/git-project-hooks.ts) — there is no step to take. */}
      {meta.manifest?.kind && (
        <Deployments ainizeUrl={meta.ainizeUrl} ainize={ainize} rowCls={rowCls} labelCls={labelCls} />
      )}

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

/** One field of the manifest's `inputs`: text / select / checkbox / number, labelled by `description`. */
function InputField({ input, value, onChange }: { input: ManifestInput; value: string; onChange: (v: string) => void }) {
  const id = `run-input-${input.name}`;
  const field = "w-full rounded border border-drive-border bg-drive-panel px-2 py-1 text-caption text-drive-text";
  const label = <label htmlFor={id} className="text-label text-drive-muted truncate" title={input.name}>{input.description ?? input.name}{input.required ? " *" : ""}</label>;
  if (input.type === "boolean") {
    return (
      <div className="flex items-center gap-2 text-caption">
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
function Deployments({ ainizeUrl, ainize, rowCls, labelCls }: {
  ainizeUrl: string; ainize: AinizeProjectState; rowCls: string; labelCls: string;
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
