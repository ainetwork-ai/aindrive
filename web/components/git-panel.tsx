"use client";
// The git panel shown above a folder's listing when that folder is a git repo
// (GET /api/drives/:id/git-meta): branch, HEAD, the last commits, the clone
// URL, and — for editors with a dirty tree — a commit box. Data loading stays
// in the shell (one fetch per folder view, refetched after a commit); this
// renders it and owns only the commit form's local state.
import { useState } from "react";
import clsx from "clsx";
import { GitBranch, GitCommitHorizontal, Copy, Check, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";
import type { GitCommit } from "@/lib/protocol";
import { apiFetch } from "@/lib/api-client";
import { relativeTime, shortSha } from "@/lib/git-panel";
import { Button } from "@/components/ui";

/** What GET git-meta answers for a folder that is a repo (the route strips `method`). */
export type GitPanelMeta = {
  exists: true;
  branch: string;
  head: GitCommit | null;
  dirty: number;
  commits: GitCommit[];
  cloneUrl: string;
  ainizeUrl: string;
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

  return (
    <section
      className="mb-4 rounded-xl border border-drive-border bg-drive-panel text-body"
      aria-label="Git repository"
      data-testid="git-panel"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 h-11 min-h-11">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <GitBranch className="w-4 h-4 text-drive-muted" aria-hidden="true" />
          <span className="font-mono text-caption">{meta.branch}</span>
        </span>
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

      <div className="flex items-center gap-2 px-4 py-2 border-t border-drive-border">
        <span className="text-label uppercase text-drive-muted shrink-0">Clone</span>
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
            className="h-8 flex-1 min-w-0 rounded-md border border-drive-border bg-drive-panel px-2.5 text-caption text-drive-text placeholder:text-drive-muted focus:border-drive-accent outline-none"
          />
          <Button type="submit" size="sm" variant="outline" loading={committing} disabled={!message.trim()} icon={<GitCommitHorizontal className="w-3.5 h-3.5" aria-hidden="true" />}>
            Commit
          </Button>
        </form>
      )}
    </section>
  );
}
