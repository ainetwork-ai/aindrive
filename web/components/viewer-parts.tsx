"use client";
// Presentational header for the file Viewer: filename, connection status,
// presence avatars, save/download/close actions. Pure props — no effects,
// no Yjs. The Viewer shell owns all state and the collab lifecycle.
import { X, Save, Download, Wifi, WifiOff } from "lucide-react";

type Presence = { id: number; name: string; color: string };

export function ViewerHeader({
  name, collaborative, showSave, status, presence, canEdit, saving, onSave, downloadUrl, onClose,
}: {
  name: string;
  /** Show collab chrome (status dot, presence avatars, view-only badge) — text + rich-text. */
  collaborative: boolean;
  /** Show the manual Save button — Monaco only (rich-text autosaves). */
  showSave: boolean;
  status: "connecting" | "connected" | "offline";
  presence: Presence[];
  canEdit: boolean;
  saving: boolean;
  onSave: () => void;
  /** fs/download URL (attachment-streamed, no size cap) — null hides the button. */
  downloadUrl: string | null;
  onClose: () => void;
}) {
  return (
    <header className="flex items-center justify-between gap-2 p-3 border-b border-drive-border">
      <div className="truncate font-medium flex items-center gap-2 min-w-0 flex-1">
        <span className="truncate">{name}</span>
        {collaborative && (
          <span className={`text-xs flex items-center gap-1 shrink-0 ${status === "connected" ? "text-green-600" : status === "connecting" ? "text-amber-600" : "text-red-600"}`}>
            {status === "connected" ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
            {status === "offline" ? "offline" : status === "connecting" ? "connecting" : ""}
          </span>
        )}
        {collaborative && presence.length > 0 && (
          <div className="flex -space-x-1.5 shrink-0 ml-1">
            {presence.slice(0, 6).map((p) => (
              <span
                key={p.id}
                title={p.name}
                className="w-6 h-6 rounded-full border-2 border-white text-[10px] font-semibold text-white flex items-center justify-center shadow-sm"
                style={{ background: p.color }}
              >
                {p.name.replace(/^0x/, "").slice(0, 2).toUpperCase()}
              </span>
            ))}
            {presence.length > 6 && (
              <span className="w-6 h-6 rounded-full border-2 border-white bg-drive-muted text-white text-[10px] font-semibold flex items-center justify-center">
                +{presence.length - 6}
              </span>
            )}
          </div>
        )}
        {collaborative && !canEdit && (
          <span className="text-[10px] uppercase tracking-wide text-drive-muted bg-drive-sidebar rounded px-1.5 py-0.5 shrink-0">view-only</span>
        )}
      </div>
      <div className="flex items-center gap-1">
        {showSave && canEdit && (
          <button onClick={onSave} disabled={saving} className="rounded px-2 py-1.5 text-sm hover:bg-drive-hover flex items-center gap-1">
            <Save className="w-4 h-4" /> {saving ? "Saving…" : "Save"}
          </button>
        )}
        {downloadUrl && (
          <a href={downloadUrl} className="rounded px-2 py-1.5 text-sm hover:bg-drive-hover flex items-center gap-1">
            <Download className="w-4 h-4" /> Download
          </a>
        )}
        <button onClick={onClose} className="rounded p-1.5 hover:bg-drive-hover">
          <X className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
