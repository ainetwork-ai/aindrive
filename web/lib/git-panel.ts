// Pure helpers behind the web git panel (components/git-panel.tsx) and the
// ▶ Run affordance (components/run-output.tsx). No React, no database: this is
// imported by client components and unit-tests directly. The server-only clone
// URL lives in lib/git-clone-url.ts.

/** Which `/api/drives/:id/run` language an entry file maps to; null = not runnable. */
export function runLanguageFor(path: string): "python" | "node" | null {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === "py") return "python";
  if (ext === "js" || ext === "mjs") return "node";
  return null;
}

/** "just now", "5m ago", "3h ago", "2d ago", else a short date. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export const shortSha = (sha: string) => sha.slice(0, 7);

// ---- run state: one reducer over the runner's SSE events ----
//
// The stream the run route relays (lib/run-ainize.ts): `stdout` / `stderr`
// {text}, `exit` {code, durationMs}, `error` {message}. The panel keeps a
// single state per entry file; "status" is what the Vercel-style dot shows.

export type RunStatus = "idle" | "running" | "success" | "failed" | "unavailable";
export type RunChunk = { stream: "stdout" | "stderr"; text: string };
export type RunState = {
  status: RunStatus;
  chunks: RunChunk[];
  exitCode: number | null;
  durationMs: number | null;
  error: string | null;
  startedAt: number | null;
};
export type RunEvent =
  | { type: "start"; at: number }
  | { type: "stdout" | "stderr"; text: string }
  | { type: "exit"; code: number; durationMs?: number; at?: number }
  | { type: "error"; message: string }
  | { type: "unavailable" };

export const RUN_IDLE: RunState = { status: "idle", chunks: [], exitCode: null, durationMs: null, error: null, startedAt: null };
const MAX_CHUNKS = 2000;

export function reduceRun(state: RunState, ev: RunEvent): RunState {
  switch (ev.type) {
    case "start": return { ...RUN_IDLE, status: "running", startedAt: ev.at };
    case "stdout":
    case "stderr": {
      const chunks = state.chunks.length >= MAX_CHUNKS ? state.chunks.slice(1) : state.chunks;
      return { ...state, chunks: [...chunks, { stream: ev.type, text: ev.text }] };
    }
    case "exit": {
      const durationMs = ev.durationMs ?? (state.startedAt !== null && ev.at !== undefined ? ev.at - state.startedAt : null);
      return { ...state, status: ev.code === 0 ? "success" : "failed", exitCode: ev.code, durationMs };
    }
    case "error": return { ...state, status: "failed", error: ev.message };
    case "unavailable": return { ...state, status: "unavailable", error: "runner unavailable" };
  }
}

/** Parse one SSE event block ("event: x\ndata: {...}") into a RunEvent, or null. */
export function parseRunEvent(block: string): RunEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return null;
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>; } catch { data = { text: dataLines.join("\n") }; }
  switch (event) {
    case "stdout":
    case "stderr": return { type: event, text: String(data.text ?? "") };
    case "exit": return { type: "exit", code: Number(data.code ?? 0), durationMs: typeof data.durationMs === "number" ? data.durationMs : undefined };
    case "error": return { type: "error", message: String(data.message ?? "run failed") };
    default: return null;
  }
}

/** Split an SSE text buffer into complete event blocks; returns the remainder. */
export function splitSse(buffer: string): { blocks: string[]; rest: string } {
  const parts = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = parts.pop() ?? "";
  return { blocks: parts.filter((b) => b.trim()), rest };
}

/** Human duration: "0.4s", "12.3s", "2m 05s". */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}
