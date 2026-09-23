"use client";
import { useEffect, useState } from "react";

export type ConvertedState =
  | { status: "pending" }
  | { status: "ready" }
  | { status: "error"; message: string };

const FIRST_DELAY_MS = 2000;
const MAX_DELAY_MS = 5000;

/**
 * Poll an fs/preview URL until the server-side conversion is ready.
 *
 * Probe = GET with `Range: bytes=0-0`: while converting the route answers
 * 202, and once the output is cached a ready check costs one byte (206) —
 * no separate probe mode on the server. The first request is what starts the
 * conversion job. Polls back off 2s → 5s and stop on unmount.
 */
export function useConverted(url: string): ConvertedState {
  const [state, setState] = useState<ConvertedState>({ status: "pending" });
  useEffect(() => {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = FIRST_DELAY_MS;
    setState({ status: "pending" });

    const poll = async () => {
      try {
        const r = await fetch(url, { headers: { Range: "bytes=0-0" }, cache: "no-store", signal: ac.signal });
        if (r.status === 200 || r.status === 206) {
          await r.body?.cancel().catch(() => {});
          setState({ status: "ready" });
          return;
        }
        // 202 = converting; 503 = server's job slots are full — keep waiting.
        if (r.status === 202 || r.status === 503) {
          timer = setTimeout(poll, delay);
          delay = Math.min(Math.round(delay * 1.5), MAX_DELAY_MS);
          return;
        }
        const detail = await r.json().then((j: { error?: string }) => j.error ?? null).catch(() => null);
        setState({ status: "error", message: messageFor(r.status, detail) });
      } catch (e) {
        if (ac.signal.aborted) return;
        setState({ status: "error", message: e instanceof Error ? e.message : "Could not load the preview." });
      }
    };
    poll();
    return () => { ac.abort(); if (timer) clearTimeout(timer); };
  }, [url]);
  return state;
}

function messageFor(status: number, detail: string | null): string {
  if (status === 501) return "Preview needs the converter service — download to open it.";
  if (status === 413) return "This file is too large to convert for preview — download to open it.";
  if (status === 422) return "This file could not be converted for preview — download to open it.";
  return detail || `Could not load the preview (${status}).`;
}
