"use client";
import { useEffect, useState } from "react";

export type ConvertedState =
  | { status: "pending" }
  | { status: "ready" }
  /** `code` = HTTP status (when there was one); `retry` = offered when the
      server was only busy, not when the file itself failed. */
  | { status: "error"; message: string; code?: number; retry?: () => void };

const FIRST_DELAY_MS = 2000;
const MAX_DELAY_MS = 5000;
// ~1 min of 503s: the job slots aren't freeing up (someone else's long
// transcodes) — stop polling and let the user retry instead of spinning.
const MAX_BUSY_POLLS = 10;
const BUSY = "The preview service is busy — try again shortly.";

/**
 * Poll an fs/preview URL until the server-side conversion is ready.
 *
 * Probe = GET with `Range: bytes=0-0`: while converting the route answers
 * 202, and once the output is cached a ready check costs one byte (206) —
 * no separate probe mode on the server. The first request is what starts the
 * conversion job. Polls back off 2s → 5s and stop on unmount, or after
 * MAX_BUSY_POLLS consecutive 503s (then `retry` restarts them).
 */
export function useConverted(url: string): ConvertedState {
  const [state, setState] = useState<ConvertedState>({ status: "pending" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = FIRST_DELAY_MS;
    let busy = 0;
    setState({ status: "pending" });

    const poll = async () => {
      try {
        const r = await fetch(url, { headers: { Range: "bytes=0-0" }, cache: "no-store", signal: ac.signal });
        if (r.status === 200 || r.status === 206) {
          await r.body?.cancel().catch(() => {});
          setState({ status: "ready" });
          return;
        }
        // 202 = converting; 503 = server's job slots are full — keep waiting
        // (a while).
        busy = r.status === 503 ? busy + 1 : 0;
        if (busy >= MAX_BUSY_POLLS) {
          setState({ status: "error", message: BUSY, code: 503, retry: () => setAttempt((n) => n + 1) });
          return;
        }
        if (r.status === 202 || r.status === 503) {
          timer = setTimeout(poll, delay);
          delay = Math.min(Math.round(delay * 1.5), MAX_DELAY_MS);
          return;
        }
        const detail = await r.json().then((j: { error?: string }) => j.error ?? null).catch(() => null);
        setState({ status: "error", message: messageFor(r.status, detail), code: r.status });
      } catch (e) {
        if (ac.signal.aborted) return;
        setState({ status: "error", message: e instanceof Error ? e.message : "Could not load the preview." });
      }
    };
    poll();
    return () => { ac.abort(); if (timer) clearTimeout(timer); };
  }, [url, attempt]);
  return state;
}

function messageFor(status: number, detail: string | null): string {
  if (status === 501) return "Preview needs the converter service — download to open it.";
  if (status === 413) return "This file is too large to convert for preview — download to open it.";
  if (status === 422) return "This file could not be converted for preview — download to open it.";
  if (status === 415) return "This file's content doesn't match its type — download to open it.";
  return detail || `Could not load the preview (${status}).`;
}
