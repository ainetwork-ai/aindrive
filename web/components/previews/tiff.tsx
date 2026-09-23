"use client";
// TIFF: browsers (except Safari) can't show it in <img>, so decode with utif
// → RGBA → canvas → PNG blob, then reuse the image viewer.
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { IFD } from "utif";
import type { PreviewProps } from "./types";
import { usePreviewBytes } from "./use-preview-bytes";
import { PreviewLoading, PreviewMessage } from "./status";
import { ZoomableImage } from "./image";

// Decoded RGBA is width*height*4 bytes — cap it so a huge scan can't take the tab down.
const MAX_PIXELS = 100_000_000;

type PageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; url: string; width: number; height: number };

const tag = (ifd: IFD, t: number) => (ifd[`t${t}`] as number[] | undefined)?.[0];

/** RGBA pixels → PNG blob: URL (the caller revokes it). */
export function rgbaToBlobUrl(rgba: Uint8ClampedArray<ArrayBuffer>, width: number, height: number): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("Canvas is unavailable."));
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(URL.createObjectURL(b)) : reject(new Error("Could not encode the image."))), "image/png"),
  );
}

export default function TiffPreview({ src }: PreviewProps) {
  const bytes = usePreviewBytes(src);
  const [utif, setUtif] = useState<typeof import("utif") | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [page, setPage] = useState<PageState>({ status: "loading" });

  useEffect(() => { void import("utif").then((m) => setUtif(m.default ?? m)); }, []);

  // Top-level IFDs with a width are the pages (EXIF/sub-IFDs aren't).
  const pages = useMemo<IFD[] | Error | null>(() => {
    if (bytes.status !== "ready" || !utif) return null;
    try {
      const ifds = utif.decode(bytes.data).filter((i) => tag(i, 256) != null);
      return ifds.length ? ifds : new Error("This TIFF contains no image.");
    } catch {
      return new Error("This file isn't a valid TIFF (it may be damaged).");
    }
  }, [bytes, utif]);

  useEffect(() => {
    if (!utif || bytes.status !== "ready" || !Array.isArray(pages)) return;
    const ifd = pages[pageIndex];
    let cancelled = false;
    let url: string | null = null;
    setPage({ status: "loading" });
    const w = tag(ifd, 256) ?? 0, h = tag(ifd, 257) ?? 0;
    if (w * h > MAX_PIXELS) {
      setPage({ status: "error", message: `This image is too large to preview (${w}×${h}). Download it to open it.` });
      return;
    }
    // Decoding is synchronous — yield a frame first so the spinner paints.
    const timer = setTimeout(() => {
      try {
        utif.decodeImage(bytes.data, ifd, pages);
        const rgba = utif.toRGBA8(ifd);
        rgbaToBlobUrl(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength), ifd.width, ifd.height).then(
          (u) => {
            if (cancelled) { URL.revokeObjectURL(u); return; }
            url = u;
            setPage({ status: "ready", url: u, width: ifd.width, height: ifd.height });
          },
          () => { if (!cancelled) setPage({ status: "error", message: "Could not display this TIFF." }); },
        );
      } catch {
        setPage({ status: "error", message: "This TIFF uses an encoding the browser preview doesn't support. Download it to open it." });
      }
    }, 16);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (url) URL.revokeObjectURL(url);
    };
  }, [utif, bytes, pages, pageIndex]);

  if (bytes.status === "error") return <PreviewMessage name={src.name} message={bytes.message} />;
  if (pages instanceof Error) return <PreviewMessage name={src.name} message={pages.message} />;
  if (page.status === "error") return <PreviewMessage name={src.name} message={page.message} />;

  const count = Array.isArray(pages) ? pages.length : 0;
  const btn = "p-1 rounded-md text-drive-muted hover:bg-drive-hover hover:text-drive-text disabled:opacity-40";
  return (
    <div className="h-full flex flex-col">
      {(count > 1 || page.status === "ready") && (
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-drive-border text-caption text-drive-muted">
          {count > 1 ? (
            <div className="flex items-center gap-1">
              <button className={btn} onClick={() => setPageIndex((i) => i - 1)} disabled={pageIndex === 0} aria-label="Previous page"><ChevronLeft className="w-4 h-4" /></button>
              <span className="tabular-nums">Page {pageIndex + 1} / {count}</span>
              <button className={btn} onClick={() => setPageIndex((i) => i + 1)} disabled={pageIndex >= count - 1} aria-label="Next page"><ChevronRight className="w-4 h-4" /></button>
            </div>
          ) : <span />}
          {page.status === "ready" && <span className="tabular-nums">{page.width} × {page.height}</span>}
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto">
        {page.status === "ready" ? <ZoomableImage src={page.url} alt={src.name} /> : <PreviewLoading />}
      </div>
    </div>
  );
}
