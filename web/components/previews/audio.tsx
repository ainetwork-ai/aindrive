"use client";
import { useState } from "react";
import clsx from "clsx";
import { fileIconForName } from "../file-icons";
import type { PreviewProps } from "./types";
import { PreviewLoading, PreviewMessage } from "./status";
import { useConverted } from "./use-converted";

const CANT_PLAY = "This audio can't play in the browser — download to open it.";

/**
 * Type icon + filename over a full-width <audio> control. Plays natively; if
 * the browser can't decode the codec (e.g. MPEG-1 Layer II .mpga/.mp2) it
 * switches to a server transcode (fs/preview ?to=mp4, AAC).
 */
export default function AudioPreview({ src }: PreviewProps) {
  // Keyed by URL so switching files starts native again.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (failedUrl !== src.url) {
    return <AudioCard name={src.name} url={src.url} onError={() => setFailedUrl(src.url)} />;
  }
  if (!src.convertUrl) return <PreviewMessage name={src.name} message={CANT_PLAY} />;
  return <Transcoded name={src.name} url={src.convertUrl("mp4")} />;
}

function Transcoded({ name, url }: { name: string; url: string }) {
  const state = useConverted(url);
  if (state.status === "pending") return <PreviewLoading label="Converting audio…" />;
  if (state.status === "error") return <PreviewMessage name={name} message={state.message} onRetry={state.retry} />;
  return <AudioCard name={name} url={url} />;
}

function AudioCard({ name, url, onError }: { name: string; url: string; onError?: () => void }) {
  const { Icon, className: tone } = fileIconForName(name);
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 p-6">
      <Icon className={clsx("w-16 h-16", tone)} />
      <div className="text-body text-drive-text text-center max-w-xs truncate" title={name}>{name}</div>
      {/* onError fires for MEDIA_ERR_SRC_NOT_SUPPORTED / DECODE on the element. */}
      <audio key={url} src={url} controls preload="metadata" onError={onError} className="w-full max-w-sm" />
    </div>
  );
}
