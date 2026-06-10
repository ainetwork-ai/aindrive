"use client";
// Presentational pieces for DriveShell. All state, effects, action handlers,
// and the lazy modal renders stay in the shell (drive-shell.tsx); these are
// pure render functions that receive data and handlers as props. Extracting
// markup only — behavior is unchanged because state ownership is unchanged.
import Link from "next/link";
import clsx from "clsx";
import {
  ChevronRight, FolderOpen, Upload, AlertTriangle, List, LayoutGrid,
  FolderPlus, Share2, HardDrive, Bot, MessageSquare, Menu, Lock,
} from "lucide-react";
import type { DriveEntry } from "@/lib/protocol";
import type { ShowcaseItem } from "@/lib/showcase";
import { RowMenu } from "./row-menu";
import { fileIcon } from "./file-icons";
import { Badge, Card, EmptyState, IconButton, Skeleton, Tooltip } from "@/components/ui";

// Shared grid track for FileGrid + its skeleton so the loading state matches.
const GRID_CLASS = "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3";

export type DriveSummary = { id: string; name: string; hostname: string | null; online: boolean };

export type ShareSummary = {
  id: string;
  token: string;
  path: string;
  role: string;
  price_usdc: number | null;
};

export type ViewMode = "list" | "grid";

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
  setAgentModalOpen, setChatOpen, chatOpen, isOwner, viewMode, setViewMode,
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
  viewMode: ViewMode;
  setViewMode: (v: ViewMode) => void;
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
        <ViewToggle viewMode={viewMode} setViewMode={setViewMode} />
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

/** Segmented list/grid switch. The active mode reads as tonal (filled accent). */
function ViewToggle({ viewMode, setViewMode }: { viewMode: ViewMode; setViewMode: (v: ViewMode) => void }) {
  const opts: { mode: ViewMode; label: string; Icon: typeof List }[] = [
    { mode: "list", label: "List view", Icon: List },
    { mode: "grid", label: "Grid view", Icon: LayoutGrid },
  ];
  return (
    <div className="flex items-center rounded-full border border-drive-border p-0.5">
      {opts.map(({ mode, label, Icon }) => (
        <Tooltip key={mode} content={label}>
          <IconButton
            aria-label={label}
            aria-pressed={viewMode === mode}
            size="sm"
            variant={viewMode === mode ? "tonal" : "text"}
            onClick={() => setViewMode(mode)}
          >
            <Icon className="w-4 h-4" />
          </IconButton>
        </Tooltip>
      ))}
    </div>
  );
}

export function FileTable({
  loading, err, entries, paidByPath, selected, setSelected, setPath, canEdit, onRowAction, isOwner, onUpload, viewMode,
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
  onUpload: (files: FileList | null) => void;
  viewMode: ViewMode;
}) {
  if (loading) return viewMode === "grid" ? <GridSkeleton /> : <ListSkeleton />;
  if (err) {
    return (
      <EmptyState
        icon={<AlertTriangle className="text-amber-500" />}
        title="Couldn’t load this folder"
        description={err}
      />
    );
  }
  if (entries.length === 0) {
    return (
      <EmptyState
        icon={<FolderOpen />}
        title="This folder is empty"
        description={canEdit ? "Drop files here or upload to get started." : "Nothing here yet."}
        action={canEdit ? <UploadButton onUpload={onUpload} /> : undefined}
      />
    );
  }
  if (viewMode === "grid") {
    return (
      <FileGrid
        entries={entries}
        paidByPath={paidByPath}
        selected={selected}
        setSelected={setSelected}
        setPath={setPath}
        canEdit={canEdit}
        onRowAction={onRowAction}
        isOwner={isOwner}
      />
    );
  }
  return (
    <table className="w-full text-body border-separate border-spacing-0">
      <thead className="text-label uppercase text-drive-muted">
        <tr>
          <th className="text-left font-medium px-3 pb-2">Name</th>
          <th className="text-left font-medium px-3 pb-2 hidden sm:table-cell w-44">Modified</th>
          <th className="text-right font-medium px-3 pb-2 hidden md:table-cell w-28">Size</th>
          <th className="w-10" />
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => {
          const paid = paidByPath.get(e.path);
          const { Icon, className: tone } = fileIcon(e);
          const isSelected = selected?.path === e.path;
          return (
            <tr
              key={e.path}
              className={clsx(
                "group h-11 cursor-pointer transition-colors",
                isSelected ? "bg-drive-selected/60" : "hover:bg-drive-hover",
              )}
              onClick={() => { if (e.isDir) setPath(e.path); else setSelected(e); }}
            >
              <td className="px-3 first:rounded-l-lg align-middle">
                <div className="flex items-center gap-3 min-w-0">
                  <Icon className={clsx("w-5 h-5 shrink-0", tone)} />
                  <span className="truncate">{e.name}</span>
                  {paid && (
                    <Badge tone="sale" className="shrink-0">
                      ${paid.price_usdc!.toFixed(2)}
                    </Badge>
                  )}
                </div>
              </td>
              <td className="px-3 align-middle hidden sm:table-cell text-caption text-drive-muted whitespace-nowrap">
                {e.mtimeMs ? new Date(e.mtimeMs).toLocaleString() : "—"}
              </td>
              <td className="px-3 align-middle hidden md:table-cell text-right text-caption text-drive-muted tabular-nums">
                {e.isDir ? "—" : prettyBytes(e.size)}
              </td>
              <td className="px-1 align-middle text-right whitespace-nowrap last:rounded-r-lg">
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

/**
 * Grid (card) view. Each card = big type icon + 2-line name + price badge, with
 * a ⋮ menu in the top-right (canEdit). Click = same setPath/setSelected as the
 * list row. The card itself is the click target; the ⋮ button stops propagation
 * (RowMenu already does) so opening the menu doesn't navigate.
 */
function FileGrid({
  entries, paidByPath, selected, setSelected, setPath, canEdit, onRowAction, isOwner,
}: {
  entries: DriveEntry[];
  paidByPath: Map<string, ShareSummary>;
  selected: DriveEntry | null;
  setSelected: (e: DriveEntry | null) => void;
  setPath: (next: string) => void;
  canEdit: boolean;
  onRowAction: (entry: DriveEntry, action: "sell" | "share" | "rename" | "delete") => void;
  isOwner: boolean;
}) {
  return (
    <div className={GRID_CLASS}>
      {entries.map((e) => {
        const paid = paidByPath.get(e.path);
        const { Icon, className: tone } = fileIcon(e);
        const isSelected = selected?.path === e.path;
        return (
          <Card
            key={e.path}
            interactive
            padded={false}
            aria-current={isSelected || undefined}
            className={clsx(
              "relative flex flex-col items-center gap-2 p-4 pt-6",
              isSelected && "ring-2 ring-drive-accent/50 bg-drive-selected/40",
            )}
            onClick={() => { if (e.isDir) setPath(e.path); else setSelected(e); }}
          >
            {canEdit && (
              <div className="absolute top-1.5 right-1.5">
                <RowMenu
                  hasPaidShare={!!paid}
                  onAction={(a) => onRowAction(e, a)}
                  canSell={isOwner}
                  canManage={canEdit}
                />
              </div>
            )}
            <Icon className={clsx("w-10 h-10 shrink-0", tone)} />
            <span className="w-full text-center text-caption text-drive-text line-clamp-2 break-words" title={e.name}>
              {e.name}
            </span>
            {paid && (
              <Badge tone="sale">${paid.price_usdc!.toFixed(2)}</Badge>
            )}
          </Card>
        );
      })}
    </div>
  );
}

/** Loading placeholder for the grid view — cards shaped like FileGrid cards. */
function GridSkeleton() {
  return (
    <div className={GRID_CLASS} aria-hidden="true">
      {Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="flex flex-col items-center gap-3 rounded-lg border border-drive-border p-4 pt-6">
          <Skeleton width={40} height={40} rounded="lg" />
          <Skeleton width="70%" height={12} />
        </div>
      ))}
    </div>
  );
}

/** Loading placeholder shaped like the list rows (icon + name + meta). */
function ListSkeleton() {
  return (
    <div className="space-y-1" aria-hidden="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 h-11 px-3">
          <Skeleton width={20} height={20} rounded="md" />
          <Skeleton width={`${40 + ((i * 13) % 35)}%`} height={14} />
          <span className="flex-1" />
          <Skeleton width={120} height={12} className="hidden sm:block" />
        </div>
      ))}
    </div>
  );
}

/**
 * Upload trigger: a <label> wrapping a hidden file input (the file-picker DOM
 * pattern the header uses). Styled as a tonal pill — Button renders a real
 * <button>, which can't host a file-input label, so this mirrors the tonal look
 * directly. Keyboard-reachable via the label's tabIndex + Enter/Space.
 */
function UploadButton({ onUpload }: { onUpload: (files: FileList | null) => void }) {
  return (
    <label
      tabIndex={0}
      className={clsx(
        "inline-flex items-center justify-center gap-2 h-9 px-4 rounded-full cursor-pointer select-none",
        "text-body font-medium bg-drive-selected text-drive-accent",
        "hover:brightness-95 active:brightness-90 transition-colors",
        "focus-visible:ring-2 focus-visible:ring-drive-accent/40",
      )}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") (e.currentTarget.querySelector("input") as HTMLInputElement)?.click();
      }}
    >
      <Upload className="w-4 h-4" />
      Upload
      <input type="file" multiple hidden onChange={(e) => onUpload(e.target.files)} />
    </label>
  );
}

/**
 * "For sale" upsell list under the file table on entry views: the drive's
 * listed paid shares the viewer doesn't cover yet. The list DTO no longer
 * carries the share token; clicking a row hits the per-shareId redirect route,
 * which resolves the token server-side and 302s to the share-gate (/s/<token>)
 * — that handles payment and lands the buyer back in the drive.
 */
export function ShowcaseSection({ driveId, items }: { driveId: string; items: ShowcaseItem[] }) {
  if (items.length === 0) return null;
  return (
    <section className="mt-8">
      <div className="px-1 text-xs uppercase tracking-wide text-drive-muted">For sale</div>
      <ul className="mt-1 text-sm">
        {items.map((it) => (
          <li key={it.shareId} className="border-b border-drive-border/70">
            <button
              onClick={() => { window.location.href = `/api/drives/${driveId}/showcase/${it.shareId}`; }}
              className="w-full flex items-center gap-3 py-3 sm:py-2 px-1 hover:bg-drive-hover cursor-pointer text-left"
            >
              <Lock className="w-5 h-5 text-drive-muted shrink-0" />
              <span className="flex-1 min-w-0 truncate">{it.leafName}</span>
              {/* Not X402Badge: it hardcodes "$…USDC", but showcase prices are in
                  the drive's policy currency. NULL currency = legacy share —
                  settle falls back to USDC, so label it the same. */}
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-lg bg-drive-selected text-xs font-semibold tabular-nums shrink-0">
                {it.price.toFixed(2)} {it.currency ?? "USDC"}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function prettyBytes(n: number) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
