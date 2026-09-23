"use client";
// Shared loading / error / no-preview states for renderers.
import { Loader2 } from "lucide-react";
import clsx from "clsx";
import { fileIconForName } from "../file-icons";

export function PreviewLoading({ label }: { label?: string }) {
  return (
    <div className="h-full min-h-[200px] flex flex-col items-center justify-center gap-2 text-drive-muted">
      <Loader2 className="w-4 h-4 animate-spin" />
      {label && <span className="text-caption">{label}</span>}
    </div>
  );
}

/** Type icon + name + message. Used for "no inline preview" and for errors. */
export function PreviewMessage({ name, message, onRetry }: { name: string; message: string; onRetry?: () => void }) {
  const { Icon, className: tone } = fileIconForName(name);
  return (
    <div className="h-full min-h-[200px] flex flex-col items-center justify-center gap-3 p-6 text-center">
      <Icon className={clsx("w-16 h-16", tone)} />
      <div className="text-body text-drive-text max-w-xs truncate" title={name}>{name}</div>
      <p className="text-caption text-drive-muted max-w-sm">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="px-3 py-1.5 rounded-full border border-drive-border text-caption text-drive-text hover:bg-drive-hover">
          Retry
        </button>
      )}
    </div>
  );
}

export const NO_PREVIEW = "No inline preview — use Download to open it locally.";
