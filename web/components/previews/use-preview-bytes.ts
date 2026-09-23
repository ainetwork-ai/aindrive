"use client";
import { useEffect, useState } from "react";
import type { PreviewSource } from "./types";

/** Largest file a renderer will pull whole into the tab to parse client-side. */
export const MAX_CLIENT_PARSE_BYTES = 200 * 1024 * 1024;

export type BytesState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: ArrayBuffer };

/** Load a source's bytes for client-side parsing, with a size guard. */
export function usePreviewBytes(src: PreviewSource): BytesState {
  const [state, setState] = useState<BytesState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    if (src.size > MAX_CLIENT_PARSE_BYTES) {
      setState({ status: "error", message: "This file is too large to preview in the browser. Download it to open it." });
      return;
    }
    setState({ status: "loading" });
    src.bytes().then(
      (data) => { if (!cancelled) setState({ status: "ready", data }); },
      (e: unknown) => { if (!cancelled) setState({ status: "error", message: e instanceof Error ? e.message : "Could not load the file." }); },
    );
    return () => { cancelled = true; };
  }, [src]);
  return state;
}

/** Memoized whole-file fetch for a URL. */
export function bytesLoader(url: string): () => Promise<ArrayBuffer> {
  let p: Promise<ArrayBuffer> | null = null;
  return () => {
    p ??= fetch(url).then(async (r) => {
      if (!r.ok) {
        const msg = await r.json().then((j: { error?: string }) => j.error).catch(() => null);
        throw new Error(msg || `Could not load the file (${r.status}).`);
      }
      return r.arrayBuffer();
    });
    p.catch(() => { p = null; });
    return p;
  };
}
