"use client";
// Presentational pieces for DriveShell. All state, effects, action handlers,
// and the lazy modal renders stay in the shell (drive-shell.tsx); these are
// pure render functions that receive data and handlers as props. Extracting
// markup only — behavior is unchanged because state ownership is unchanged.
import Link from "next/link";
import clsx from "clsx";
import {
  ChevronRight, Folder, FileText, FileCode, FileImage, File as FileIcon,
  FolderPlus, Upload, Share2, Loader2, HardDrive, Bot, MessageSquare, Menu,
} from "lucide-react";
import type { DriveEntry } from "@/lib/protocol";
import { RowMenu } from "./row-menu";
import { X402Badge } from "./x402-badges";

export type DriveSummary = { id: string; name: string; hostname: string | null; online: boolean };

export type ShareSummary = {
  id: string;
  token: string;
  path: string;
  role: string;
  price_usdc: number | null;
};

type Crumb = { label: string; path: string };

export function DriveSidebar({
  sidebarOpen, setSidebarOpen, onNewFolder, canEdit, drives, driveId, role,
}: {
  sidebarOpen: boolean;
  setSidebarOpen: (v: boolean) => void;
  onNewFolder: () => void;
  canEdit: boolean;
  drives: DriveSummary[];
  driveId: string;
  role: string;
}) {
  return (
    <aside
      className={clsx(
        "fixed inset-y-0 left-0 z-40 w-64 bg-drive-sidebar border-r border-drive-border p-4 gap-2 flex flex-col transform transition-transform duration-200",
        "md:static md:translate-x-0",
        sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
      )}
    >
      <Link
        href="/"
        onClick={() => setSidebarOpen(false)}
        className="flex items-center gap-2 font-semibold text-lg px-2 py-1.5"
      >
        <HardDrive className="w-5 h-5 text-drive-accent" /> aindrive
      </Link>
      <div className="mt-2">
        <button
          onClick={onNewFolder}
          disabled={!canEdit}
          className="w-full flex items-center gap-3 rounded-full bg-white border border-drive-border shadow-sm px-4 py-3 hover:shadow-md disabled:opacity-50"
        >
          <FolderPlus className="w-5 h-5 text-drive-accent" /> New folder
        </button>
      </div>
      <div className="mt-3 px-3 text-xs uppercase tracking-wide text-drive-muted">My drives</div>
      <nav className="mt-1 text-sm space-y-0.5 overflow-y-auto scrollbar-thin">
        {drives.map((d) => {
          const active = d.id === driveId;
          return (
            <Link
              key={d.id}
              href={`/d/${d.id}`}
              className={clsx(
                "w-full flex items-center gap-2 px-3 py-1.5 rounded-2xl",
                active ? "bg-drive-selected" : "hover:bg-drive-hover",
              )}
            >
              <HardDrive className="w-4 h-4 text-drive-accent shrink-0" />
              <span className="flex-1 min-w-0">
                <span className="block truncate">{d.name}</span>
                {d.hostname && (
                  <span className="block truncate text-xs text-drive-muted">{d.hostname}</span>
                )}
              </span>
              <span
                className={clsx(
                  "w-2 h-2 rounded-full shrink-0",
                  d.online ? "bg-emerald-500" : "bg-drive-muted/40",
                )}
                title={d.online ? "agent online" : "agent offline"}
              />
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto text-xs text-drive-muted px-2">Role: {role}</div>
    </aside>
  );
}

export function DriveHeader({
  setSidebarOpen, crumbs, setPath, canEdit, onUpload, setShareOpen, path, role,
  setAgentModalOpen, setChatOpen, chatOpen, isOwner,
}: {
  setSidebarOpen: (v: boolean) => void;
  crumbs: Crumb[];
  setPath: (next: string) => void;
  canEdit: boolean;
  onUpload: (files: FileList | null) => void;
  setShareOpen: (v: { path: string; focus?: "sell" } | null) => void;
  path: string;
  role: string;
  setAgentModalOpen: (v: boolean) => void;
  setChatOpen: (fn: (v: boolean) => boolean) => void;
  chatOpen: boolean;
  isOwner: boolean;
}) {
  return (
    <header className="flex items-center justify-between gap-2 px-3 sm:px-6 py-3 border-b border-drive-border bg-white">
      <div className="flex items-center gap-1 min-w-0 text-sm">
        <button
          aria-label="Open menu"
          onClick={() => setSidebarOpen(true)}
          className="md:hidden mr-1 p-1.5 -ml-1 rounded hover:bg-drive-hover shrink-0"
        >
          <Menu className="w-5 h-5" />
        </button>
        {crumbs.map((c, i) => {
          // On <sm screens, collapse middle crumbs into "…" so the current
          // folder always stays visible. Keep the first (drive root) and
          // the last (current folder), drop the rest behind a tappable
          // collapse that jumps to the parent.
          const isFirst = i === 0;
          const isLast = i === crumbs.length - 1;
          const isMiddle = !isFirst && !isLast;
          const collapseMiddle = crumbs.length > 3;
          const hideOnMobile = isMiddle && collapseMiddle && i !== crumbs.length - 2;
          const isLastHidden = collapseMiddle && i === crumbs.length - 2;
          return (
            <span key={c.path} className="flex items-center gap-1 min-w-0">
              {i > 0 && (
                <ChevronRight
                  className={clsx(
                    "w-4 h-4 text-drive-muted shrink-0",
                    hideOnMobile && "hidden sm:inline-block",
                  )}
                />
              )}
              {isLastHidden && (
                <button
                  onClick={() => setPath(c.path)}
                  title={`Go to ${c.label}`}
                  className="sm:hidden px-1.5 rounded hover:bg-drive-hover text-drive-muted"
                >
                  …
                </button>
              )}
              <button
                onClick={() => setPath(c.path)}
                className={clsx(
                  "truncate hover:underline",
                  hideOnMobile && "hidden sm:inline",
                )}
              >
                {c.label}
              </button>
            </span>
          );
        })}
      </div>
      <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
        <label
          aria-label="Upload"
          className={clsx(
            "cursor-pointer flex items-center gap-2 rounded-full px-2.5 sm:px-3 py-1.5 text-sm border border-drive-border hover:bg-drive-hover",
            !canEdit && "opacity-50 pointer-events-none",
          )}
        >
          <Upload className="w-4 h-4" /> <span className="hidden sm:inline">Upload</span>
          <input type="file" multiple hidden onChange={(e) => onUpload(e.target.files)} />
        </label>
        {isOwner && (
          <button
            aria-label="Share"
            onClick={() => setShareOpen({ path })}
            className="flex items-center gap-2 rounded-full bg-drive-accent text-white px-2.5 sm:px-3 py-1.5 text-sm hover:bg-drive-accentHover"
          >
            <Share2 className="w-4 h-4" /> <span className="hidden sm:inline">Share</span>
          </button>
        )}
        {isOwner && (
          <button
            aria-label="Create Agent"
            onClick={() => setAgentModalOpen(true)}
            title="Create Agent"
            className="flex items-center gap-2 rounded-full border border-drive-border px-2.5 sm:px-3 py-1.5 text-sm hover:bg-drive-hover"
          >
            <Bot className="w-4 h-4" /> <span className="hidden sm:inline">Agent</span>
          </button>
        )}
        <button
          aria-label="Folder chat"
          onClick={() => setChatOpen((v) => !v)}
          title="Folder chat"
          className={clsx(
            "flex items-center gap-2 rounded-full border border-drive-border px-2.5 sm:px-3 py-1.5 text-sm hover:bg-drive-hover",
            chatOpen && "bg-blue-50 border-blue-300",
          )}
        >
          <MessageSquare className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}

export function FileTable({
  loading, err, entries, paidByPath, selected, setSelected, setPath, canEdit, onRowAction, isOwner,
}: {
  loading: boolean;
  err: string | null;
  entries: DriveEntry[];
  paidByPath: Map<string, ShareSummary>;
  selected: DriveEntry | null;
  setSelected: (e: DriveEntry | null) => void;
  setPath: (next: string) => void;
  canEdit: boolean;
  onRowAction: (entry: DriveEntry, action: "sell" | "share" | "rename" | "delete") => void;
  isOwner: boolean;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center text-drive-muted gap-2 py-20">
        <Loader2 className="w-4 h-4 animate-spin" /> connecting to your agent…
      </div>
    );
  }
  if (err) {
    return <div className="text-center text-red-600 py-20">{err}</div>;
  }
  if (entries.length === 0) {
    return <div className="text-center text-drive-muted py-20">This folder is empty.</div>;
  }
  return (
    <table className="w-full text-sm">
      <thead className="text-drive-muted">
        <tr className="border-b border-drive-border">
          <th className="text-left font-medium py-2">Name</th>
          <th className="text-left font-medium py-2 hidden sm:table-cell">Modified</th>
          <th className="text-right font-medium py-2 hidden md:table-cell">Size</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => {
          const paid = paidByPath.get(e.path);
          return (
            <tr
              key={e.path}
              className={clsx(
                "border-b border-drive-border/70 hover:bg-drive-hover cursor-pointer",
                selected?.path === e.path && "bg-drive-selected/60"
              )}
              onClick={() => { if (e.isDir) setPath(e.path); else setSelected(e); }}
            >
              <td className="py-3 sm:py-2 align-middle">
                <div className="flex items-center gap-3 min-w-0">
                  <EntryIcon entry={e} />
                  <span className="truncate">{e.name}</span>
                  {paid && <X402Badge price={paid.price_usdc!} />}
                </div>
              </td>
              <td className="py-3 sm:py-2 hidden sm:table-cell text-drive-muted">
                {new Date(e.mtimeMs).toLocaleString()}
              </td>
              <td className="py-3 sm:py-2 hidden md:table-cell text-right text-drive-muted">
                {e.isDir ? "—" : prettyBytes(e.size)}
              </td>
              <td className="py-3 sm:py-2 text-right whitespace-nowrap">
                {canEdit && (
                  <RowMenu
                    hasPaidShare={!!paid}
                    onAction={(a) => onRowAction(e, a)}
                    canSell={isOwner}
                    canManage={canEdit}
                  />
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function EntryIcon({ entry }: { entry: DriveEntry }) {
  if (entry.isDir) return <Folder className="w-5 h-5 text-drive-accent shrink-0" />;
  if (entry.mime.startsWith("image/")) return <FileImage className="w-5 h-5 text-drive-muted shrink-0" />;
  if (/\.(ts|tsx|js|jsx|py|rs|go|html|css|json)$/.test(entry.name)) return <FileCode className="w-5 h-5 text-drive-muted shrink-0" />;
  if (entry.mime.startsWith("text/")) return <FileText className="w-5 h-5 text-drive-muted shrink-0" />;
  return <FileIcon className="w-5 h-5 text-drive-muted shrink-0" />;
}

function prettyBytes(n: number) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
