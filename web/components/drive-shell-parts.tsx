"use client";
// Presentational pieces for DriveShell. All state, effects, action handlers,
// and the lazy modal renders stay in the shell (drive-shell.tsx); these are
// pure render functions that receive data and handlers as props. Extracting
// markup only — behavior is unchanged because state ownership is unchanged.
import Link from "next/link";
import clsx from "clsx";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ChevronRight, FolderOpen, Upload, AlertTriangle, List, LayoutGrid,
  FolderPlus, Plus, Share2, HardDrive, Bot, MessageSquare, Menu as MenuIcon, Lock,
  Search, X, ArrowUp, ArrowDown, SearchX, Settings, LogOut, EyeOff,
} from "lucide-react";
import type { DriveEntry } from "@/lib/protocol";
import type { SortKey, SortState } from "@/lib/sort-entries";
import type { ShowcaseItem } from "@/lib/showcase";
import { RowMenu, rowMenuItems, type Action } from "./row-menu";
import { fileIcon, fileIconForName, FileBadge } from "./file-icons";
import { Badge, Button, Card, EmptyState, IconButton, Menu, Skeleton, Tooltip, type MenuItem } from "@/components/ui";

// Shared grid track for FileGrid + its skeleton so the loading state matches.
const GRID_CLASS = "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3";

export type DriveSummary = { id: string; name: string; hostname: string | null; online: boolean };

export type ShareSummary = {
  id: string;
  token: string;
  path: string;
  role: string;
  price_usdc: number | null;
  // Token the sale is priced in (drive policy symbol); null = legacy USDC.
  // GET /shares already returns it — badges show "<amount> <symbol>".
  currency: string | null;
  // 1 = advertised in the drive storefront (public); 0 = private (link-only)
  // sale, hidden from non-entitled viewers. Drives the owner-side badge styling.
  listed: number;
};

export type ViewMode = "list" | "grid";

type Crumb = { label: string; path: string };

export function DriveSidebar({
  sidebarOpen, setSidebarOpen, onNewFolder, onUpload, canEdit, drives, driveId, role, onCreateAgent,
}: {
  sidebarOpen: boolean;
  setSidebarOpen: (v: boolean) => void;
  onNewFolder: () => void;
  onUpload: (files: FileList | null) => void;
  canEdit: boolean;
  drives: DriveSummary[];
  driveId: string;
  role: string;
  /** Owner-only: open the Create-agent modal (relocated here from the header). */
  onCreateAgent: () => void;
}) {
  const isOwner = role === "owner";
  // Hidden input the "New → Upload files" menu item triggers, so the sidebar's
  // New button mirrors Drive's (folder + upload) without threading a shared ref.
  const uploadRef = useRef<HTMLInputElement>(null);
  const newItems: MenuItem[] = [
    { label: "New folder", icon: <FolderPlus className="w-4 h-4" />, onClick: onNewFolder },
    { label: "Upload files", icon: <Upload className="w-4 h-4" />, onClick: () => uploadRef.current?.click() },
  ];
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
        className="flex items-center gap-2 font-semibold text-title px-2 py-1.5"
      >
        <HardDrive className="w-5 h-5 text-drive-accent" /> aindrive
      </Link>
      <div className="mt-2">
        <Menu
          align="start"
          items={newItems}
          trigger={({ onClick, "aria-expanded": expanded, "aria-haspopup": haspopup }) => (
            <button
              onClick={onClick}
              disabled={!canEdit}
              aria-expanded={expanded}
              aria-haspopup={haspopup}
              className="w-full flex items-center gap-3 rounded-full bg-drive-panel border border-drive-border shadow-e1 px-4 py-3 text-body font-medium hover:shadow-e2 transition disabled:opacity-50"
            >
              <Plus className="w-5 h-5 text-drive-accent" /> New
            </button>
          )}
        />
        <input ref={uploadRef} type="file" multiple hidden onChange={(e) => onUpload(e.target.files)} />
      </div>
      <div className="mt-3 px-3 text-label uppercase text-drive-muted">My drives</div>
      <nav className="mt-1 text-body space-y-0.5 overflow-y-auto scrollbar-thin">
        {drives.map((d) => {
          const active = d.id === driveId;
          return (
            <Link
              key={d.id}
              href={`/d/${d.id}`}
              className={clsx(
                "w-full flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors",
                active ? "bg-drive-selected" : "hover:bg-drive-hover",
              )}
            >
              <HardDrive className="w-4 h-4 text-drive-accent shrink-0" />
              <span className="flex-1 min-w-0">
                <span className="block truncate">{d.name}</span>
                {d.hostname && (
                  <span className="block truncate text-caption text-drive-muted">{d.hostname}</span>
                )}
              </span>
              <Tooltip content={d.online ? "agent online" : "agent offline"}>
                <span
                  className={clsx(
                    "w-2 h-2 rounded-full shrink-0",
                    d.online ? "bg-emerald-500" : "bg-drive-muted/40",
                  )}
                />
              </Tooltip>
            </Link>
          );
        })}
      </nav>
      {/* Drive-administration shelf — owner-only actions relocated off the
          top bar so the file view's chrome stays calm. */}
      <div className="mt-auto pt-2 border-t border-drive-border space-y-0.5">
        {isOwner && (
          <button
            onClick={() => { onCreateAgent(); setSidebarOpen(false); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-body text-drive-text hover:bg-drive-hover"
          >
            <Bot className="w-4 h-4 text-drive-muted" /> Create agent
          </button>
        )}
        {isOwner && (
          <Link
            href={`/d/${driveId}/manage`}
            onClick={() => setSidebarOpen(false)}
            className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-body text-drive-text hover:bg-drive-hover"
          >
            <Settings className="w-4 h-4 text-drive-muted" /> Manage
          </Link>
        )}
        <div className="px-2 pt-1">
          <Badge tone="neutral">Role: {role}</Badge>
        </div>
        <AccountFooter />
      </div>
    </aside>
  );
}

/** Sidebar account footer: who am I + sign out. Self-contained (fetches
 *  /api/auth/me itself) so the otherwise-presentational sidebar doesn't grow
 *  a user prop just for this. Sign-out was previously reachable only from the
 *  home page header — invisible to anyone living inside a drive view. */
function AccountFooter() {
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/auth/me").then((r) => r.json()).then((d) => {
      if (d?.user?.email) setEmail(d.user.email);
    }).catch(() => {});
  }, []);
  return (
    <form action="/api/auth/logout" method="POST">
      <button
        type="submit"
        className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-body text-drive-text hover:bg-drive-hover"
      >
        <LogOut className="w-4 h-4 text-drive-muted shrink-0" />
        <span className="flex-1 min-w-0 text-left">
          <span className="block">Sign out</span>
          {email && <span className="block truncate text-caption text-drive-muted">{email}</span>}
        </span>
      </button>
    </form>
  );
}

export function DriveHeader({
  setSidebarOpen, crumbs, setPath, canEdit, onUpload, setShareOpen, path, role,
  setChatOpen, chatOpen, isOwner, viewMode, setViewMode, query, onQuery,
}: {
  setSidebarOpen: (v: boolean) => void;
  crumbs: Crumb[];
  setPath: (next: string) => void;
  canEdit: boolean;
  onUpload: (files: FileList | null) => void;
  setShareOpen: (v: { path: string; focus?: "sell" } | null) => void;
  path: string;
  role: string;
  setChatOpen: (fn: (v: boolean) => boolean) => void;
  chatOpen: boolean;
  isOwner: boolean;
  viewMode: ViewMode;
  setViewMode: (v: ViewMode) => void;
  query: string;
  onQuery: (q: string) => void;
}) {
  return (
    <header className="flex items-center justify-between gap-2 px-3 sm:px-6 py-3 border-b border-drive-border bg-white">
      <div className="flex items-center gap-1 min-w-0 text-sm">
        <button
          aria-label="Open menu"
          onClick={() => setSidebarOpen(true)}
          className="md:hidden mr-1 p-1.5 -ml-1 rounded hover:bg-drive-hover shrink-0"
        >
          <MenuIcon className="w-5 h-5" />
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
        {/* Folder-scoped filename filter (client-side). Hidden on <sm where the
            crumbs already fight for space — mobile search is a follow-up. */}
        <div className="relative hidden sm:block">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-drive-muted pointer-events-none" />
          <input
            type="search"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search in this folder"
            aria-label="Search in this folder"
            className="w-40 md:w-56 rounded-full border border-drive-border bg-drive-sidebar/60 pl-8 pr-7 py-1.5 text-sm text-drive-text placeholder:text-drive-muted focus:outline-none focus:ring-2 focus:ring-drive-accent/40 focus:bg-white [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              aria-label="Clear search"
              onClick={() => onQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-drive-muted hover:text-drive-text"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
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

/** Clickable column header: active column shows the direction arrow; clicking
 *  it again flips the direction (state lives in the shell). */
function SortHeader({ label, k, sort, onSort, align, className }: {
  label: string;
  k: SortKey;
  sort: SortState;
  onSort: (k: SortKey) => void;
  align?: "right";
  className?: string;
}) {
  const active = sort.key === k;
  const Arrow = sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th className={className} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
      <button
        onClick={() => onSort(k)}
        className={clsx(
          "inline-flex items-center gap-1 uppercase hover:text-drive-text",
          align === "right" && "flex-row-reverse",
          active && "text-drive-text",
        )}
      >
        {label}
        {active && <Arrow className="w-3.5 h-3.5" />}
      </button>
    </th>
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
  loading, err, driveId, entries, sort, onSort, query, onQuery, paidByPath, selected, setSelected, setPath, canEdit, onRowAction, isOwner, onUpload, viewMode,
  onNewFolder, ctxMenu, setCtxMenu,
}: {
  loading: boolean;
  err: string | null;
  driveId: string;
  entries: DriveEntry[];
  sort: SortState;
  onSort: (key: SortKey) => void;
  query: string;
  onQuery: (q: string) => void;
  paidByPath: Map<string, ShareSummary>;
  selected: DriveEntry | null;
  setSelected: (e: DriveEntry | null) => void;
  setPath: (next: string) => void;
  canEdit: boolean;
  onRowAction: (entry: DriveEntry, action: "sell" | "share" | "rename" | "delete") => void;
  isOwner: boolean;
  onUpload: (files: FileList | null) => void;
  viewMode: ViewMode;
  onNewFolder: () => void;
  ctxMenu: { entry: DriveEntry | null; x: number; y: number } | null;
  setCtxMenu: (v: { entry: DriveEntry | null; x: number; y: number } | null) => void;
}) {
  // Hidden input backing the context-menu "Upload…" item (no label wrapper
  // here — the menu item clicks it programmatically).
  const uploadInputRef = useRef<HTMLInputElement>(null);

  // Drag-drop upload (canEdit only). dragDepth counts enter/leave so the
  // overlay doesn't flicker as the pointer crosses child elements — it hides
  // only when the count returns to 0 (left the area entirely).
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const dndProps = canEdit ? {
    onDragEnter: (e: React.DragEvent) => {
      if (!Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (e.dataTransfer.files?.length) onUpload(e.dataTransfer.files);
    },
  } : {};

  // Open the positioned menu at the cursor. entry=null → empty-area menu.
  const openCtx = (ev: React.MouseEvent, entry: DriveEntry | null) => {
    ev.preventDefault();
    ev.stopPropagation();
    setCtxMenu({ entry, x: ev.clientX, y: ev.clientY });
  };

  // Items for whatever the menu targets: an entry's row actions, or the
  // empty-area New folder / Upload (canEdit only). Same gates as RowMenu.
  const ctxItems: MenuItem[] = !ctxMenu
    ? []
    : ctxMenu.entry
      ? rowMenuItems({
          hasPaidShare: !!paidByPath.get(ctxMenu.entry.path),
          onAction: (a: Action) => onRowAction(ctxMenu.entry!, a),
          canSell: isOwner,
          canManage: canEdit,
        })
      : canEdit
        ? [
            { label: "New folder", icon: <FolderPlus className="w-4 h-4" />, onClick: onNewFolder },
            { label: "Upload…", icon: <Upload className="w-4 h-4" />, onClick: () => uploadInputRef.current?.click() },
          ]
        : [];

  const contextMenu = ctxMenu && ctxItems.length > 0 && (
    <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxItems} onClose={() => setCtxMenu(null)} />
  );

  let body: React.ReactNode;
  if (loading) {
    body = viewMode === "grid" ? <GridSkeleton /> : <ListSkeleton />;
  } else if (err) {
    // "agent offline" is the common case and a dead-end if shown raw — a drive
    // is served by a local CLI agent, so an offline agent means nothing loads.
    // Turn it into a role-aware next step instead of jargon.
    const offline = /offline/i.test(err);
    body = (
      <EmptyState
        icon={<AlertTriangle className="text-amber-500" />}
        title={offline ? "This drive is offline" : "Couldn’t load this folder"}
        description={
          offline
            ? isOwner
              ? "The local aindrive agent that serves this drive isn’t connected. Start the agent in this drive’s folder to bring it back online — files and sharing resume automatically."
              : "This drive’s agent is offline right now. Check back once it’s brought back online."
            : err
        }
      />
    );
  } else if (entries.length === 0 && query.trim()) {
    // The folder has files, the filter just matched none of them.
    body = (
      <EmptyState
        icon={<SearchX />}
        title={`No files match “${query.trim()}”`}
        description="Try a different name, or clear the search."
        action={
          <button onClick={() => onQuery("")} className="text-sm text-drive-accent hover:underline">
            Clear search
          </button>
        }
      />
    );
  } else if (entries.length === 0) {
    body = (
      <EmptyState
        icon={<FolderOpen />}
        title="This folder is empty"
        description={canEdit ? "Drop files here or upload to get started." : "Nothing here yet."}
        action={canEdit ? <UploadButton onUpload={onUpload} /> : undefined}
      />
    );
  } else if (viewMode === "grid") {
    body = (
      <FileGrid
        driveId={driveId}
        entries={entries}
        paidByPath={paidByPath}
        selected={selected}
        setSelected={setSelected}
        setPath={setPath}
        canEdit={canEdit}
        onRowAction={onRowAction}
        isOwner={isOwner}
        onContextMenuEntry={openCtx}
      />
    );
  } else {
    body = (
      <table className="w-full text-body border-separate border-spacing-0">
        <thead className="text-label uppercase text-drive-muted">
          <tr>
            <SortHeader label="Name" k="name" sort={sort} onSort={onSort} className="text-left font-medium px-3 pb-2" />
            <SortHeader label="Modified" k="mtime" sort={sort} onSort={onSort} className="text-left font-medium px-3 pb-2 hidden sm:table-cell w-44" />
            <SortHeader label="Size" k="size" sort={sort} onSort={onSort} align="right" className="text-right font-medium px-3 pb-2 hidden md:table-cell w-28" />
            <th className="w-10" />
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const paid = paidByPath.get(e.path);
            const ic = fileIcon(e);
            const isSelected = selected?.path === e.path;
            return (
              <tr
                key={e.path}
                className={clsx(
                  "group h-11 cursor-pointer transition-colors",
                  isSelected ? "bg-drive-selected/60" : "hover:bg-drive-hover",
                  // Unlisted (private) sale → slightly translucent so the owner
                  // sees at a glance it's hidden from buyers.
                  paid && !paid.listed && "opacity-60",
                )}
                // A locked (paid, unpaid-for) entry opens the locked preview, never
                // navigates in — listing/reading it would 402 (R-VIS-PAID-001).
                onClick={() => { if (!e.locked && e.isDir) setPath(e.path); else setSelected(e); }}
                onContextMenu={(ev) => openCtx(ev, e)}
              >
                <td className="px-3 first:rounded-l-lg align-middle">
                  <div className="flex items-center gap-3 min-w-0">
                    <FileBadge icon={ic} locked={!!e.locked} className="shrink-0" />
                    <span className="truncate">{e.name}</span>
                    {paid && (
                      <SaleBadge price={paid.price_usdc!} currency={paid.currency} listed={!!paid.listed} />
                    )}
                    {e.locked && (
                      <Badge tone="sale" icon={<Lock />} className="shrink-0">
                        {(e.price ?? 0).toFixed(2)} {e.currency ?? "USDC"}
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

  return (
    // min-h-full so empty-area right-click + drop work across the whole scroll
    // area, not just the few rows. The empty-area context handler fires when the
    // event wasn't stopped by a row/card (entry handlers stopPropagation).
    <div
      className="relative min-h-full"
      onContextMenu={(ev) => openCtx(ev, null)}
      {...dndProps}
    >
      {body}
      {contextMenu}
      {dragging && (
        <div
          className="pointer-events-none absolute inset-0 z-40 flex flex-col items-center justify-center gap-3
                     rounded-xl border-2 border-dashed border-drive-accent bg-drive-accent/5 backdrop-blur-[1px]"
          aria-hidden="true"
        >
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-drive-selected text-drive-accent">
            <Upload className="w-7 h-7" />
          </div>
          <p className="text-subtitle text-drive-accent">Drop files to upload</p>
        </div>
      )}
      <input ref={uploadInputRef} type="file" multiple hidden onChange={(e) => onUpload(e.target.files)} />
    </div>
  );
}

/**
 * Cursor-positioned popover for the right-click menu. Shares the Menu
 * primitive's item visuals but is `fixed` to the viewport at (x, y) — the
 * dropdown Menu aligns to a trigger, which a context menu has none of. Clamps
 * to the viewport after mount, closes on outside-click / Esc / scroll, and
 * supports arrow-key navigation (autofocuses the first item).
 */
function ContextMenu({
  x, y, items, onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [pos, setPos] = useState({ x, y });
  const [active, setActive] = useState(() => items.findIndex((it) => !it.disabled));

  // Clamp so the menu stays on-screen (flip left/up near the right/bottom edge).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const nx = x + width > window.innerWidth ? Math.max(4, x - width) : x;
    const ny = y + height > window.innerHeight ? Math.max(4, y - height) : y;
    setPos({ x: nx, y: ny });
  }, [x, y]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    // Any scroll dismisses (the anchor point would drift otherwise).
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  // Track DOM focus to the highlighted item so SR + visuals follow keyboard nav.
  useEffect(() => {
    if (active >= 0) itemRefs.current[active]?.focus();
  }, [active]);

  const move = (dir: 1 | -1) => {
    const n = items.length;
    setActive((i) => {
      for (let s = 1; s <= n; s++) {
        const j = (i + dir * s + n * s) % n;
        if (!items[j]?.disabled) return j;
      }
      return i;
    });
  };

  return (
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-50 min-w-[12rem] py-1 bg-drive-panel rounded-md shadow-e2 border border-drive-border animate-[menu-in_120ms_ease-out] origin-top-left"
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); onClose(); }
        else if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
        else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (!items[active]?.disabled) { items[active].onClick(); onClose(); }
        }
      }}
    >
      {items.map((item, i) => (
        <button
          key={i}
          ref={(el) => { itemRefs.current[i] = el; }}
          type="button"
          role="menuitem"
          tabIndex={-1}
          disabled={item.disabled}
          onMouseEnter={() => !item.disabled && setActive(i)}
          onClick={() => { if (!item.disabled) { item.onClick(); onClose(); } }}
          className={clsx(
            "flex w-full items-center gap-2.5 px-3 h-9 text-body text-left outline-none transition-colors",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            item.danger ? "text-red-600" : "text-drive-text",
            active === i && !item.disabled && (item.danger ? "bg-red-50" : "bg-drive-hover"),
          )}
        >
          {item.icon && <span className="shrink-0 w-4 h-4 flex items-center justify-center">{item.icon}</span>}
          <span className="truncate">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Grid (card) view. Each card = big type icon + 2-line name + price badge, with
 * a ⋮ menu in the top-right (canEdit). Click = same setPath/setSelected as the
 * list row.
 *
 * The card is a `div role="button"` (NOT Card's `interactive` <button>) on
 * purpose: the ⋮ menu trigger is itself a <button>, and a button nested inside a
 * button is invalid HTML + an a11y violation. A div-with-role keeps the card
 * keyboard-activatable (Enter/Space) while letting the ⋮ button be a real,
 * separately-focusable button. The ⋮ stops propagation so it doesn't navigate.
 */
function FileGrid({
  driveId, entries, paidByPath, selected, setSelected, setPath, canEdit, onRowAction, isOwner, onContextMenuEntry,
}: {
  driveId: string;
  entries: DriveEntry[];
  paidByPath: Map<string, ShareSummary>;
  selected: DriveEntry | null;
  setSelected: (e: DriveEntry | null) => void;
  setPath: (next: string) => void;
  canEdit: boolean;
  onRowAction: (entry: DriveEntry, action: "sell" | "share" | "rename" | "delete") => void;
  isOwner: boolean;
  onContextMenuEntry: (ev: React.MouseEvent, entry: DriveEntry) => void;
}) {
  // Locked (paid, unpaid-for) entries open the locked preview, never navigate in.
  const activate = (e: DriveEntry) => { if (!e.locked && e.isDir) setPath(e.path); else setSelected(e); };
  return (
    <div className={GRID_CLASS}>
      {entries.map((e) => {
        const paid = paidByPath.get(e.path);
        const { Icon, className: tone } = fileIcon(e);
        const isSelected = selected?.path === e.path;
        return (
          <Card
            key={e.path}
            padded={false}
            role="button"
            tabIndex={0}
            aria-current={isSelected || undefined}
            className={clsx(
              "relative flex flex-col items-center gap-2 p-4 pt-6 cursor-pointer outline-none",
              "transition-shadow duration-150 hover:shadow-e2 active:shadow-e1",
              "focus-visible:ring-2 focus-visible:ring-drive-accent/40",
              isSelected && "ring-2 ring-drive-accent/50 bg-drive-selected/40",
              // Unlisted (private) sale → slightly translucent (owner cue).
              paid && !paid.listed && "opacity-60",
            )}
            onClick={() => activate(e)}
            onKeyDown={(ev) => {
              // Enter/Space activate the card the way clicking it would. Ignore
              // events bubbling up from the ⋮ button (its own target handles them).
              if (ev.target !== ev.currentTarget) return;
              if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); activate(e); }
            }}
            onContextMenu={(ev) => onContextMenuEntry(ev, e)}
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
            {/* Keyed by path+mtime so replacing the file remounts the visual —
                otherwise a failed thumbnail's `broken` state would stick to the
                reused instance and pin the icon fallback forever. */}
            <GridVisual key={`${e.path}-${e.mtimeMs}`} driveId={driveId} entry={e} Icon={Icon} tone={tone} locked={!!e.locked} />
            <span className="w-full text-center text-caption text-drive-text line-clamp-2 break-words" title={e.name}>
              {e.name}
            </span>
            {paid && (
              <SaleBadge price={paid.price_usdc!} currency={paid.currency} listed={!!paid.listed} />
            )}
            {e.locked && (
              <Badge tone="sale" icon={<Lock />}>{(e.price ?? 0).toFixed(2)} {e.currency ?? "USDC"}</Badge>
            )}
          </Card>
        );
      })}
    </div>
  );
}

/** Card visual: image files render a server-resized thumbnail (lazy, cached by
 *  mtime — the &v= param keys the browser's immutable cache); anything else,
 *  and any thumbnail that fails (agent offline, oversized, decode error),
 *  falls back to the type icon. */
function GridVisual({ driveId, entry, Icon, tone, locked }: {
  driveId: string;
  entry: DriveEntry;
  Icon: ReturnType<typeof fileIcon>["Icon"];
  tone: string;
  locked?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  // Skip the thumbnail for locked items: the carve-out 402s fs/thumbnail anyway,
  // and we must not preview paid image content. Show the lock-overlay icon.
  if (!entry.isDir && entry.mime.startsWith("image/") && !broken && !locked) {
    return (
      <img
        src={`/api/drives/${driveId}/fs/thumbnail?path=${encodeURIComponent(entry.path)}&v=${entry.mtimeMs}`}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
        draggable={false}
        className="w-full aspect-[4/3] object-cover rounded-md bg-drive-sidebar"
      />
    );
  }
  return <FileBadge icon={{ Icon, className: tone }} locked={!!locked} size="lg" />;
}

/**
 * Owner-side sale badge. Blue = LISTED (public, advertised in the storefront);
 * muted + eye-off = UNLISTED (private, link-only — hidden from non-entitled
 * viewers). Lets an owner tell a sale's visibility state at a glance.
 */
function SaleBadge({ price, currency, listed }: { price: number; currency: string | null; listed: boolean }) {
  const amt = `${price.toFixed(2)} ${currency ?? "USDC"}`;
  if (listed) return <Badge tone="sale" className="shrink-0">{amt}</Badge>;
  return (
    <span title="비공개 판매 — 스토어프론트에 안 보이고 링크로만 판매돼요" className="inline-flex shrink-0">
      <Badge tone="neutral" icon={<EyeOff />}>{amt}</Badge>
    </span>
  );
}

/**
 * Preview pane for a LOCKED (paid, not-yet-bought) entry — shown instead of the
 * Viewer so a click never tries to read the content (which 402s). Makes the
 * required token unmistakable: price + ticker, with a one-click purchase for
 * listed sales (unlisted ones sell by the owner's private link). R-VIS-PAID-001.
 */
export function LockedPreview({ driveId, entry, onClose }: {
  driveId: string;
  entry: DriveEntry;
  onClose: () => void;
}) {
  const ticker = entry.currency ?? "USDC";
  const price = (entry.price ?? 0).toFixed(2);
  const canBuy = !!(entry.listed && entry.shareId);
  return (
    <aside className="fixed inset-0 z-30 w-full sm:static sm:inset-auto sm:z-auto sm:w-[520px] lg:w-[640px] border-l border-drive-border bg-white flex flex-col min-w-0">
      <div className="flex h-12 items-center gap-2 border-b border-drive-border px-3">
        <FileBadge icon={fileIcon(entry)} locked className="shrink-0" />
        <span className="truncate text-body font-medium">{entry.name}</span>
        <IconButton aria-label="Close" className="ml-auto" onClick={onClose}><X className="w-4 h-4" /></IconButton>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        <EmptyState
          icon={<Lock />}
          title="구매해야 볼 수 있어요"
          description={`이 ${entry.isDir ? "폴더" : "파일"}는 판매 중이라 잠겨 있어요. 아래 금액을 결제하면 잠금이 해제됩니다.`}
          action={
            <div className="flex flex-col items-center gap-3">
              <Badge tone="sale" icon={<Lock />} className="text-body">{price} {ticker}</Badge>
              {canBuy ? (
                <Button onClick={() => { window.location.href = `/api/drives/${driveId}/showcase/${entry.shareId}`; }}>
                  {price} {ticker} 결제하고 잠금 해제
                </Button>
              ) : (
                <p className="max-w-xs text-caption text-drive-muted">
                  소유자가 공유한 구매 링크로만 결제할 수 있어요.
                </p>
              )}
            </div>
          }
        />
      </div>
    </aside>
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
      <div className="flex items-center gap-2 px-1 mb-2 text-label uppercase text-drive-muted">
        <Lock className="w-3.5 h-3.5" /> For sale
      </div>
      <div className={GRID_CLASS}>
        {items.map((it) => {
          // leafName is the ONLY path info the showcase DTO carries (security:
          // never the full path). Guess the type icon from the leaf alone.
          const { Icon, className } = fileIconForName(it.leafName);
          return (
            <Card
              key={it.shareId}
              interactive
              onClick={() => { window.location.href = `/api/drives/${driveId}/showcase/${it.shareId}`; }}
              className="group relative flex flex-col items-center gap-2 text-center"
            >
              {/* Lock overlay marks it as paywalled until purchased. */}
              <span className="absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded-full bg-drive-bg/80 text-drive-muted">
                <Lock className="w-3.5 h-3.5" />
              </span>
              <Icon className={clsx("w-12 h-12 shrink-0", className)} />
              <span className="w-full truncate text-body" title={it.leafName}>{it.leafName}</span>
              {/* Policy currency, not hardcoded USDC. NULL = legacy → USDC. */}
              <Badge tone="sale">{it.price.toFixed(2)} {it.currency ?? "USDC"}</Badge>
              <span className="text-caption text-drive-accent opacity-0 group-hover:opacity-100 transition">Buy to unlock →</span>
            </Card>
          );
        })}
      </div>
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
