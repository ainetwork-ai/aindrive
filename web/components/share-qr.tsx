"use client";

import { useEffect, useRef, useState } from "react";
import { Download, X } from "lucide-react";
import QRCode from "qrcode";
import { IconButton } from "@/components/ui";

/**
 * QR for one share link — the "hand this to a phone" surface.
 *
 * Lives inline under the link it encodes, in the Share drawer, per the drawer's
 * create-in-context rule: a QR is another way to hand out THIS item's link, not
 * a drive-wide tool. The drive-wide link ledger stays in Manage → Links.
 *
 * Inline rather than a modal on purpose. `ui/Modal` is `fixed inset-0 z-50` and
 * installs its own focus trap, Escape handler and body scroll-lock; opening one
 * inside the Share drawer (itself a Modal) puts two traps and two Escape
 * handlers on the same keystroke. An inline panel has none of that, and matches
 * the drawer's "one flat sheet of sections" layout.
 *
 * Rendered to a canvas rather than an <img src={dataUrl}>: the canvas is also
 * what the download button reads, so the saved PNG is the exact pixels on
 * screen instead of a second, separately-encoded image that could drift.
 *
 * `qrcode` is bundled rather than loaded from a CDN because the app's CSP
 * (middleware.ts) allows scripts from 'self' only.
 */

/** Big enough to scan off a laptop screen at arm's length, small enough for the drawer. */
const QR_PIXELS = 200;

export function ShareQrPanel({
  url,
  label,
  onClose,
}: {
  url: string;
  /** Used for the downloaded filename, so saved codes are tellable apart. */
  label: string;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    QRCode.toCanvas(canvas, url, {
      width: QR_PIXELS,
      margin: 2, // the quiet zone; 2 modules is the spec minimum scanners rely on
      errorCorrectionLevel: "M",
      color: { dark: "#000000", light: "#ffffff" },
    }).catch((e: unknown) => {
      // A URL too long for a QR symbol is the realistic failure here; say so
      // rather than leaving a blank white square that looks like a render bug.
      if (!cancelled) setError(e instanceof Error ? e.message : "Could not render QR code");
    });
    return () => { cancelled = true; };
  }, [url]);

  function downloadPng() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `aindrive-${label.replace(/[^A-Za-z0-9_-]+/g, "-") || "share"}-qr.png`;
    a.click();
  }

  return (
    <div className="mt-1 mb-2 rounded-lg border border-drive-border bg-drive-sidebar p-3">
      <div className="flex items-start gap-3">
        {error ? (
          <p className="flex-1 text-caption text-red-600 py-6 text-center">{error}</p>
        ) : (
          // Explicit white plate: the drawer sits on a tinted surface
          // (drive.sidebar #f2f5f9), and a QR's quiet zone has to be the same
          // light tone as its light modules or scanners lose the symbol edge.
          <div className="bg-white rounded-md p-2 shrink-0">
            <canvas
              ref={canvasRef}
              width={QR_PIXELS}
              height={QR_PIXELS}
              aria-label={`QR code for ${url}`}
              className="block"
            />
          </div>
        )}
        <div className="flex-1 min-w-0 flex flex-col gap-2">
          <div className="flex items-start justify-between gap-2">
            <p className="text-caption text-drive-text font-medium">Scan to open</p>
            {/* Distinct name from the row's toggle, which is also "Hide QR code"
                when open — two controls in one list item must not share an
                accessible name. */}
            <IconButton size="sm" variant="text" aria-label="Close QR code" onClick={onClose}>
              <X className="w-3.5 h-3.5" />
            </IconButton>
          </div>
          <p className="text-[11px] text-drive-muted leading-snug">
            Whoever scans this still signs in — the link grants access to their
            account, it does not bypass login.
          </p>
          {!error && (
            <button
              type="button"
              onClick={downloadPng}
              className="self-start inline-flex items-center gap-1.5 text-caption text-drive-accent hover:underline"
            >
              <Download className="w-3.5 h-3.5" /> Download PNG
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
