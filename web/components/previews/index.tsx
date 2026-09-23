"use client";
// Dispatches a file to its inline renderer. Each renderer is its own lazy
// chunk: pdf.js, SheetJS, three.js, libarchive wasm etc. load only when a file
// of that kind is opened. Text/markdown are NOT here — the Viewer shell owns
// those because they carry the Yjs collaboration lifecycle.
import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import type { PreviewKind } from "@/lib/preview-kind";
import type { PreviewProps } from "./types";
import { PreviewLoading, PreviewMessage, NO_PREVIEW } from "./status";

const loading = () => <PreviewLoading />;
const lazy = (load: () => Promise<{ default: ComponentType<PreviewProps> }>) =>
  dynamic(load, { ssr: false, loading });

const RENDERERS: Partial<Record<PreviewKind, ComponentType<PreviewProps>>> = {
  image: lazy(() => import("./image")),
  tiff: lazy(() => import("./tiff")),
  psd: lazy(() => import("./psd")),
  pdf: lazy(() => import("./pdf")),
  video: lazy(() => import("./video")),
  audio: lazy(() => import("./audio")),
  docx: lazy(() => import("./docx")),
  sheet: lazy(() => import("./sheet")),
  pptx: lazy(() => import("./pptx")),
  archive: lazy(() => import("./archive")),
  font: lazy(() => import("./font")),
  dxf: lazy(() => import("./dxf")),
  converted: lazy(() => import("./converted")),
};

/** True when `kind` renders through this module (vs. the Viewer's editors). */
export function hasInlineRenderer(kind: PreviewKind): boolean {
  return kind in RENDERERS;
}

export function PreviewBody({ kind, ...props }: PreviewProps & { kind: PreviewKind }) {
  const R = RENDERERS[kind];
  if (!R) return <PreviewMessage name={props.src.name} message={NO_PREVIEW} />;
  return <R {...props} />;
}
