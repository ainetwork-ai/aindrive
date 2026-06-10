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
} from "lucide-react";
import type { DriveEntry } from "@/lib/protocol";
import type { ShowcaseItem } from "@/lib/showcase";
import { RowMenu, rowMenuItems, type Action } from "./row-menu";
import { fileIcon, fileIconForName } from "./file-icons";
import { Badge, Card, EmptyState, IconButton, Menu, Skeleton, Tooltip, type MenuItem } from "@/components/ui";

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
  sidebarOpen, setSidebarOpen, onNewFolder, onUpload, canEdit, drives, driveId, role,
}: {
  sidebarOpen: boolean;
  setSidebarOpen: (v: boolean) => void;
  onNewFolder: () => void;
  onUpload: (files: FileList | null) => void;
  canEdit: boolean;
  drives: DriveSummary[];
  driveId: string;
  role: string;
}) {
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
      <div className="mt-auto px-2">
        <Badge tone="neutral">Role: {role}</Badge>
      </div>
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
  onNewFolder, ctxMenu, setCtxMenu,
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
    body = (
      <EmptyState
        icon={<AlertTriangle className="text-amber-500" />}
        title="Couldn’t load this folder"
        description={err}
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
                onContextMenu={(ev) => openCtx(ev, e)}
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
  entries, paidByPath, selected, setSelected, setPath, canEdit, onRowAction, isOwner, onContextMenuEntry,
}: {
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
  const activate = (e: DriveEntry) => { if (e.isDir) setPath(e.path); else setSelected(e); };
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
