"use client";
import type { PreviewProps } from "./types";
import { PreviewMessage, NO_PREVIEW } from "./status";

// STUB — replaced by the real renderer.
/** Renders a PDF from a same-origin URL. Reused by `converted` for server-converted output. */
export function PdfDocument({ url, name }: { url: string; name: string }) {
  void url;
  return <PreviewMessage name={name} message={NO_PREVIEW} />;
}

export default function PdfPreview({ src }: PreviewProps) {
  return <PdfDocument url={src.url} name={src.name} />;
}
