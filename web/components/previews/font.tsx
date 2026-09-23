"use client";
// Font specimen via the FontFace API: the browser's own font parser (OTS
// sanitizes it) loads the file under a throwaway family name.
import { useEffect, useState } from "react";
import type { PreviewProps } from "./types";
import { usePreviewBytes } from "./use-preview-bytes";
import { PreviewLoading, PreviewMessage } from "./status";
import { readFontNames, type FontNames } from "./font-name";

const SIZES = [12, 18, 24, 36, 48, 72];
const DEFAULT_SAMPLE = "다람쥐 헌 쳇바퀴에 타고파 · The quick brown fox jumps over the lazy dog";
const CHARSET = [
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "abcdefghijklmnopqrstuvwxyz",
  "0123456789",
  "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
  "다람쥐 헌 쳇바퀴에 타고파",
  "가나다라마바사아자차카타파하",
];

let seq = 0;

type State =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; family: string; names: FontNames };

export default function FontPreview({ src }: PreviewProps) {
  const bytes = usePreviewBytes(src);
  const [state, setState] = useState<State>({ status: "loading" });
  const [sample, setSample] = useState(DEFAULT_SAMPLE);

  useEffect(() => {
    if (bytes.status !== "ready") return;
    let cancelled = false;
    const family = `aindrive-font-preview-${++seq}`;
    const face = new FontFace(family, bytes.data);
    setState({ status: "loading" });
    Promise.all([face.load(), readFontNames(bytes.data)]).then(
      ([loaded, names]) => {
        if (cancelled) return;
        document.fonts.add(loaded);
        setState({ status: "ready", family, names });
      },
      () => { if (!cancelled) setState({ status: "error" }); },
    );
    return () => {
      cancelled = true;
      document.fonts.delete(face);
    };
  }, [bytes]);

  if (bytes.status === "error") return <PreviewMessage name={src.name} message={bytes.message} />;
  if (state.status === "error") {
    return <PreviewMessage name={src.name} message="This file isn't a font the browser can load (it may be damaged or an unsupported format). Download it to open it." />;
  }
  if (state.status !== "ready") return <PreviewLoading />;

  const { family, names } = state;
  const title = names.family ?? src.name.replace(/\.[^.]+$/, "");
  const fontStyle = { fontFamily: `"${family}", system-ui` };
  return (
    <div className="p-4 sm:p-6 flex flex-col gap-6 min-w-0">
      <header className="min-w-0">
        <h2 className="text-display text-drive-text break-words" style={fontStyle}>{title}</h2>
        <p className="text-caption text-drive-muted mt-1">
          {[names.style, src.name.split(".").pop()?.toUpperCase()].filter(Boolean).join(" · ")}
        </p>
      </header>

      <label className="flex flex-col gap-1">
        <span className="text-label uppercase text-drive-muted">Sample text</span>
        <input
          value={sample}
          onChange={(e) => setSample(e.target.value)}
          placeholder="Type to preview"
          className="h-9 px-3 rounded-md border border-drive-border text-body focus:outline-none focus:ring-2 focus:ring-drive-accent"
        />
      </label>

      <section className="flex flex-col gap-4">
        {SIZES.map((px) => (
          <div key={px} className="flex flex-col gap-1 min-w-0">
            <span className="text-label text-drive-muted tabular-nums">{px}px</span>
            <p className="text-drive-text break-words leading-tight" style={{ ...fontStyle, fontSize: px }}>
              {sample || DEFAULT_SAMPLE}
            </p>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-1 border-t border-drive-border pt-4">
        <span className="text-label uppercase text-drive-muted">Characters</span>
        {CHARSET.map((line) => (
          <p key={line} className="text-drive-text break-all text-[22px] leading-snug" style={fontStyle}>{line}</p>
        ))}
      </section>
    </div>
  );
}
