"use client";
// Legacy Office / iWork / PostScript / XPS: converted to PDF server-side
// (fs/preview → converter sidecar), then shown with the same pdf.js viewer as
// native PDFs.
import { extOf } from "@/lib/preview-kind";
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
  if (state.status === "error") {
    // 415 = the route's magic-byte check: e.g. a PEM "server.key" or a text file named .doc.
    const message = state.code === 415
      ? `This file doesn't look like a .${extOf(name)} document — download to open it.`
      : state.message;
    return <PreviewMessage name={name} message={message} onRetry={state.retry} />;
  }
  return <PdfDocument url={url} name={name} />;
}
