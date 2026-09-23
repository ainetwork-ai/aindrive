"use client";
// PowerPoint (.pptx/.pptm/.ppsx/.ppsm/.potx) via pptx-preview, slides stacked
// vertically inside a script-less SandboxedDocFrame and zoomed to the panel.
//
// pptx-preview builds nodes with the app's global `document` (no factory hook)
// and appends them into the container we give it — a node inside the frame —
// so they end up in the sandbox. It sets run text via `innerHTML`, on a node
// that is still detached in the APP document at that moment; parsed markup
// there (e.g. <img onerror>) would run in the app realm. Its XML reader never
// decodes entities, so text shouldn't carry a raw "<", but we escape any that
// do before rendering rather than rely on that.
import { useCallback, useEffect, useRef } from "react";
import type { PreviewProps } from "./types";
import { OfficeBytes } from "./office-password";
import { SandboxedDocFrame } from "./sandboxed-doc-frame";

/** Slides are laid out at this width, then zoomed to fit the panel. */
const RENDER_WIDTH = 960;

const CSS = `
.pptx-host{padding:0 12px;}
.pptx-preview-wrapper{background:transparent!important;width:auto!important;}
.pptx-preview-slide-wrapper{margin:0 auto 16px!important;box-shadow:0 1px 3px rgb(15 23 42/.2);}
`;

/** Escape "<" in every run's `text` (the innerHTML sink) across the parsed deck. */
function neutralizeText(root: unknown) {
  const seen = new WeakSet<object>();
  const stack: unknown[] = [root];
  while (stack.length) {
    const o = stack.pop();
    if (!o || typeof o !== "object" || seen.has(o) || ArrayBuffer.isView(o) || o instanceof ArrayBuffer || o instanceof Blob) continue;
    seen.add(o);
    const rec = o as Record<string, unknown>;
    for (const k of Object.keys(rec)) {
      if (k === "_zipContents") continue; // the raw zip — large, and not rendered
      const v = rec[k];
      if (k === "text" && typeof v === "string") { if (v.includes("<")) rec[k] = v.replace(/</g, "&lt;"); }
      else if (v && typeof v === "object") stack.push(v);
    }
  }
}

function fitSlides(doc: Document, width: number) {
  const host = doc.querySelector<HTMLElement>(".pptx-host");
  if (host) host.style.zoom = String(Math.min(1.5, (width - 24) / RENDER_WIDTH));
}

function Deck({ name, data }: { name: string; data: ArrayBuffer }) {
  const destroyRef = useRef<(() => void) | null>(null);
  useEffect(() => () => destroyRef.current?.(), []);

  const render = useCallback(async (doc: Document) => {
    const { init } = await import("pptx-preview");
    const host = doc.createElement("div");
    host.className = "pptx-host";
    doc.body.append(host);
    const previewer = init(host, { width: RENDER_WIDTH, mode: "list" });
    destroyRef.current = () => previewer.destroy();
    const deck = await previewer.load(data);
    neutralizeText(deck);
    const count = deck.slides?.length ?? 0;
    if (!count) throw new Error("This presentation has no slides.");
    let failed = 0;
    for (let i = 0; i < count; i++) {
      // One unsupported shape shouldn't blank the whole deck.
      try { previewer.htmlRender.renderSlide(i); } catch { failed++; }
    }
    if (failed === count) throw new Error("Could not render this presentation. Download it to open it.");
  }, [data]);

  return <SandboxedDocFrame name={name} render={render} fit={fitSlides} css={CSS} />;
}

export default function PptxPreview({ src }: PreviewProps) {
  return <OfficeBytes src={src}>{(data) => <Deck name={src.name} data={data} />}</OfficeBytes>;
}
