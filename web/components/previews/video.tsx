"use client";
// Video: play natively when the container is one browsers decode; otherwise
// (avi, wmv, flv, mpeg-ps, 3gp…) — or when native playback errors out on the
// codec (HEVC, ProRes in .mov/.mp4) — play a server transcode (fs/preview
// ?to=mp4, H.264/AAC) instead.
import { useEffect, useRef, useState } from "react";
import { isNativeVideo } from "@/lib/preview-kind";
import type { PreviewProps } from "./types";
import { PreviewLoading, PreviewMessage } from "./status";
import { useConverted } from "./use-converted";

const CANT_PLAY = "This video can't play in the browser — download to open it.";

export default function VideoPreview({ src }: PreviewProps) {
  // Keyed by URL so switching files starts native again.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const native = isNativeVideo(src.name) && failedUrl !== src.url;
  if (native) return <Player url={src.url} onError={() => setFailedUrl(src.url)} />;
  if (!src.convertUrl) return <PreviewMessage name={src.name} message={CANT_PLAY} />;
  return <Transcoded name={src.name} url={src.convertUrl("mp4")} />;
}

function Transcoded({ name, url }: { name: string; url: string }) {
  const state = useConverted(url);
  if (state.status === "pending") return <PreviewLoading label="Converting… this can take a while for videos" />;
  if (state.status === "error") return <PreviewMessage name={name} message={state.message} />;
  return <Player url={url} />;
}

function Player({ url, onError }: { url: string; onError?: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  // An undecodable codec shows up two ways: `error` (MEDIA_ERR_SRC_NOT_SUPPORTED
  // / DECODE), or — Chromium with HEVC/ProRes — metadata loads but videoWidth
  // stays 0 while the audio track would play. Either → caller transcodes. (An
  // audio-only .mp4 also trips the second check; its transcode is cheap and
  // plays the same audio.) Checked from an effect, not onLoadedMetadata: a
  // fast Range response can deliver metadata before React's handler sees it.
  useEffect(() => {
    const v = ref.current;
    if (!v || !onError) return;
    const check = () => { if (v.error || (v.readyState >= 1 && v.videoWidth === 0)) onError(); };
    check();
    v.addEventListener("loadedmetadata", check);
    v.addEventListener("error", check);
    return () => { v.removeEventListener("loadedmetadata", check); v.removeEventListener("error", check); };
  }, [url, onError]);
  return (
    <div className="h-full flex items-center justify-center bg-black p-2">
      {/* preload=metadata: grab duration/dimensions only; bytes flow on
          play/seek via Range requests. */}
      <video
        ref={ref}
        key={url}
        src={url}
        controls
        preload="metadata"
        playsInline
        className="max-w-full max-h-full rounded-md"
      />
    </div>
  );
}
