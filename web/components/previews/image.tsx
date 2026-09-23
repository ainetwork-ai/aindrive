"use client";
import { useState } from "react";
import clsx from "clsx";
import type { PreviewProps } from "./types";

// Subtle checkerboard so transparent images read against the white panel.
export const CHECKERBOARD: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg,#f1f3f4 25%,transparent 25%),linear-gradient(-45deg,#f1f3f4 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#f1f3f4 75%),linear-gradient(-45deg,transparent 75%,#f1f3f4 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0,0 8px,8px -8px,-8px 0",
};

/**
 * Fit-to-width image with click-to-toggle 1:1 zoom. Also the display surface
 * for decoded formats (TIFF, PSD) — they hand it a blob: URL of a PNG.
 */
export function ZoomableImage({ src, alt }: { src: string; alt: string }) {
  const [zoomed, setZoomed] = useState(false);
  return (
    <div
      className={clsx("min-h-full flex items-center justify-center p-4", zoomed ? "overflow-auto cursor-zoom-out" : "cursor-zoom-in")}
      style={CHECKERBOARD}
      onClick={() => setZoomed((v) => !v)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className={clsx("rounded-md shadow-e1", zoomed ? "max-w-none" : "max-w-full h-auto")} />
    </div>
  );
}

export default function ImagePreview({ src }: PreviewProps) {
  return <ZoomableImage src={src.url} alt={src.name} />;
}
