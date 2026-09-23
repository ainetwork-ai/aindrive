"use client";
import type { PreviewProps } from "./types";
import { PreviewMessage, NO_PREVIEW } from "./status";

// STUB — replaced by the real renderer.
export default function DocxPreview({ src }: PreviewProps) {
  return <PreviewMessage name={src.name} message={NO_PREVIEW} />;
}
