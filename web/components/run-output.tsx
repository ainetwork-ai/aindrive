"use client";
// ▶ Run for a `.py` / `.js` / `.mjs` file inside a repo folder: the button in
// the file row, the Vercel-style status dot, and the output panel rendered
// under the row. State per entry file lives in useRunner (one reducer over the
// run route's SSE events, lib/git-panel.ts); the components only render it.
import { ainizeLinkClass } from "./ainize-brand";
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Play, Square, ExternalLink, ChevronDown, ChevronUp } from "lucide-react";
import {
  RUN_IDLE, reduceRun, parseRunEvent, splitSse, formatDuration, type RunState, type RunStatus,
} from "@/lib/git-panel";

export type Runner = {
  runs: Record<string, RunState>;
  open: Record<string, boolean>;
  /** `env`: the answers to the manifest's inputs, already as `INPUT_<NAME>` (lib/run-inputs.ts inputsToEnv). */
  run: (entryPath: string, env?: Record<string, string>) => void;
  stop: (entryPath: string) => void;
  toggle: (entryPath: string) => void;
};

/** Per-folder run state. `repo` is the folder that is a git repo; entry paths are drive paths inside it. */
export function useRunner(driveId: string, repo: string | null): Runner {
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const aborts = useRef(new Map<string, AbortController>());

  // Leaving the folder drops its runs and cancels any still streaming.
  useEffect(() => {
    setRuns({}); setOpen({});
    const map = aborts.current;
    return () => { for (const c of map.values()) c.abort(); map.clear(); };
  }, [driveId, repo]);

  const dispatch = useCallback((p: string, ev: Parameters<typeof reduceRun>[1]) => {
    setRuns((prev) => ({ ...prev, [p]: reduceRun(prev[p] ?? RUN_IDLE, ev) }));
  }, []);

  const stop = useCallback((p: string) => {
    aborts.current.get(p)?.abort();
    aborts.current.delete(p);
  }, []);

  const run = useCallback(async (entryPath: string, env?: Record<string, string>) => {
    if (repo === null) return;
    stop(entryPath);
    const ctrl = new AbortController();
    aborts.current.set(entryPath, ctrl);
    dispatch(entryPath, { type: "start", at: Date.now() });
    setOpen((o) => ({ ...o, [entryPath]: true }));
    const prefix = repo === "" ? "" : repo + "/";
    const entry = entryPath.startsWith(prefix) ? entryPath.slice(prefix.length) : entryPath;
    try {
      const res = await fetch(`/api/drives/${driveId}/run`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo, entry, ...(env && Object.keys(env).length ? { env } : {}) }), signal: ctrl.signal,
      });
      if (res.status === 503) { dispatch(entryPath, { type: "unavailable" }); return; }
      if (!res.ok || !res.body) {
        let msg = `run failed (${res.status})`;
        try { const j = await res.json(); if (j?.error) msg = j.error; } catch {}
        dispatch(entryPath, { type: "error", message: msg });
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let exited = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const { blocks, rest } = splitSse(buf);
        buf = rest;
        for (const b of blocks) {
          const ev = parseRunEvent(b);
          if (!ev) continue;
          if (ev.type === "exit") { exited = true; dispatch(entryPath, { ...ev, at: Date.now() }); }
          else dispatch(entryPath, ev);
        }
      }
      if (!exited) dispatch(entryPath, { type: "error", message: "stream ended without an exit code" });
    } catch (e) {
      if ((e as Error).name === "AbortError") dispatch(entryPath, { type: "error", message: "stopped" });
      else dispatch(entryPath, { type: "error", message: (e as Error).message || "network error" });
    } finally {
      if (aborts.current.get(entryPath) === ctrl) aborts.current.delete(entryPath);
    }
  }, [driveId, repo, dispatch, stop]);

  const toggle = useCallback((p: string) => setOpen((o) => ({ ...o, [p]: !o[p] })), []);
  return { runs, open, run, stop, toggle };
}

const DOT: Record<RunStatus, string> = {
  idle: "bg-drive-border",
  running: "bg-drive-muted/70 animate-pulse",
  success: "bg-emerald-500",
  failed: "bg-red-500",
  unavailable: "bg-amber-500",
};
const DOT_LABEL: Record<RunStatus, string> = {
  idle: "not run", running: "running", success: "succeeded", failed: "failed", unavailable: "runner unavailable",
};

/** The small status dot: grey pulsing = running, green = exit 0, red = failed, amber = runner down. */
export function RunDot({ status, className }: { status: RunStatus; className?: string }) {
  return (
    <span
      role="status"
      aria-label={DOT_LABEL[status]}
      title={DOT_LABEL[status]}
      className={clsx("inline-block h-2 w-2 shrink-0 rounded-full", DOT[status], className)}
    />
  );
}

/** Inline row actions: "Run" / "Stop", "Output" (toggles the panel), with the status dot. */
export function RunActions({ state, isOpen, onRun, onStop, onToggle }: {
  state: RunState; isOpen: boolean; onRun: () => void; onStop: () => void; onToggle: () => void;
}) {
  const running = state.status === "running";
  const link = "inline-flex items-center gap-1 text-caption font-medium text-drive-muted hover:text-drive-text transition-colors";
  return (
    <span className="inline-flex items-center gap-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
      {state.status !== "idle" && <RunDot status={state.status} />}
      {running ? (
        <button type="button" className={link} onClick={onStop} aria-label="Stop run">
          <Square className="w-3 h-3" aria-hidden="true" /> Stop
        </button>
      ) : (
        <button type="button" className={ainizeLinkClass} onClick={onRun} aria-label="Run file on ainize" title="Run on ainize">
          <Play className="w-3 h-3" aria-hidden="true" /> Run
        </button>
      )}
      {state.status !== "idle" && (
        <button type="button" className={link} onClick={onToggle} aria-expanded={isOpen}>
          Output {isOpen ? <ChevronUp className="w-3 h-3" aria-hidden="true" /> : <ChevronDown className="w-3 h-3" aria-hidden="true" />}
        </button>
      )}
    </span>
  );
}

/**
 * The output panel under a file row: stdout/stderr in order, exit code, duration,
 * and — when the repo is bound to an ainize project — a link to that project's
 * page (`openUrl`; null hides the link rather than pointing at ainize's front page).
 */
export function RunOutput({ state, entryName, openUrl }: { state: RunState; entryName: string; openUrl: string | null }) {
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "nearest" }); }, [state.chunks.length]);
  const summary =
    state.status === "running" ? "Running…"
    : state.status === "unavailable" ? "Runner unavailable — ainize has no runner right now. Try again later."
    : state.status === "success" ? `Exited 0 · ${formatDuration(state.durationMs)}`
    : state.exitCode !== null ? `Exited ${state.exitCode} · ${formatDuration(state.durationMs)}`
    : state.error ?? "Failed";
  return (
    <div className="rounded-lg border border-drive-border bg-drive-panel text-caption overflow-hidden" data-run-status={state.status}>
      <div className="flex items-center gap-2 px-3 h-8 border-b border-drive-border text-drive-muted">
        <RunDot status={state.status} />
        <span className="font-mono text-drive-text truncate">{entryName}</span>
        <span className="truncate">{summary}</span>
        {openUrl && (
          <a
            href={openUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 font-medium text-drive-muted hover:text-drive-text"
          >
            Open in ainize <ExternalLink className="w-3 h-3" aria-hidden="true" />
          </a>
        )}
      </div>
      <pre className="m-0 max-h-72 overflow-auto scrollbar-thin px-3 py-2 font-mono text-[12px] leading-5 whitespace-pre-wrap wrap-break-word text-drive-text">
        {state.chunks.length === 0 && state.status === "running" && <span className="text-drive-muted">waiting for output…</span>}
        {state.chunks.map((c, i) => (
          <span key={i} className={c.stream === "stderr" ? "text-red-600" : undefined}>{c.text}</span>
        ))}
        {state.error && state.status !== "unavailable" && <span className="text-red-600">{"\n"}{state.error}</span>}
        <div ref={bottom} />
      </pre>
    </div>
  );
}
