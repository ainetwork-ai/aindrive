"use client";
// Legacy Office / iWork / PostScript / XPS: converted to PDF server-side
// (fs/preview → converter sidecar), then shown with the same pdf.js viewer as
// native PDFs.
import type { PreviewProps } from "./types";
import { PreviewLoading, PreviewMessage, NO_PREVIEW } from "./status";
import { useConverted } from "./use-converted";
import { PdfDocument } from "./pdf";

export default function ConvertedPreview({ src }: PreviewProps) {
  // Archive members never round-trip through the server.
  if (!src.convertUrl) return <PreviewMessage name={src.name} message={NO_PREVIEW} />;
  return <ConvertedPdf name={src.name} url={src.convertUrl("pdf")} />;
}

function ConvertedPdf({ name, url }: { name: string; url: string }) {
  const state = useConverted(url);
  if (state.status === "pending") return <PreviewLoading label="Converting for preview…" />;
  if (state.status === "error") return <PreviewMessage name={name} message={state.message} />;
  return <PdfDocument url={url} name={name} />;
}
