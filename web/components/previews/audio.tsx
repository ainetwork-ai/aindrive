"use client";
import clsx from "clsx";
import { fileIconForName } from "../file-icons";
import type { PreviewProps } from "./types";

/** Type icon + filename over a full-width <audio> control. */
export default function AudioPreview({ src }: PreviewProps) {
  const { Icon, className: tone } = fileIconForName(src.name);
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 p-6">
      <Icon className={clsx("w-16 h-16", tone)} />
      <div className="text-body text-drive-text text-center max-w-xs truncate" title={src.name}>{src.name}</div>
      <audio src={src.url} controls className="w-full max-w-sm" />
    </div>
  );
}
