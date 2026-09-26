"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { toast } from "sonner";
import type { DriveEntry } from "@/lib/protocol";
import type { ShowcaseItem } from "@/lib/showcase";
import { apiFetch } from "@/lib/api-client";
import { sortEntries, type SortKey, type SortState } from "@/lib/sort-entries";
import { locationPath, viewerHistory } from "@/lib/drive-location";
import {
  DriveSidebar, DriveHeader, FileTable, ShowcaseSection, LockedPreview,
  type DriveSummary, type ShareSummary, type ViewMode,
} from "./drive-shell-parts";

// These four are only rendered on user action (open a file, open chat, open
// the share/agent modal), so we load them on demand instead of bundling them
// into the drive workspace's initial JS. Viewer is the heaviest — it pulls in
// the Monaco editor, y-monaco, and the Yjs provider. ssr:false because they're
// interactive client-only surfaces with no SSR value.
const Viewer = dynamic(() => import("./viewer").then((m) => m.Viewer), { ssr: false });
const ShareDialog = dynamic(() => import("./share-dialog").then((m) => m.ShareDialog), { ssr: false });
const McpModal = dynamic(() => import("./mcp-modal").then((m) => m.McpModal), { ssr: false });
const CreateAgentModal = dynamic(() => import("./create-agent-modal").then((m) => m.CreateAgentModal), { ssr: false });
const FolderChat = dynamic(() => import("./folder-chat").then((m) => m.FolderChat), { ssr: false });

type Props = {
  driveId: string;
  driveName: string;
  /** folder listed first — always a folder; the page resolves a file ?path to its folder */
  initialFolder: string;
  /** highest folder the breadcrumb may reach (the member's grant, or "" for the drive root) */
  scopeRoot: string;
  /** file opened in the viewer on arrival (a file ?path, or a single-file grant) */
  initialOpen?: DriveEntry | null;
  initialRole?: string;
  /** Grant-listing member's accessible entries; "" renders these instead of fs/list (synthetic root). */
  entryItems?: DriveEntry[];
};

type Loc = { folder: string; open: DriveEntry | null };
const HISTORY_KEY = "aindriveLoc";

export function DriveShell({ driveId, driveName, initialFolder, scopeRoot, initialOpen, initialRole, entryItems }: Props) {
  // Location = the listed folder + the open file. ?path mirrors whichever the
  // user is looking at (the file when one is open), so links, reloads and the
  // back button all land on the same view. See lib/drive-location.ts.
  const [loc, setLoc] = useState<Loc>({ folder: initialFolder, open: initialOpen ?? null });
  const path = loc.folder;
  const selected = loc.open;
  // True while the current history entry was pushed by opening a file here:
  // switching files replaces it and closing steps back over it (viewerHistory).
  const openPushedRef = useRef(false);

  // Each history entry carries its Loc: the URL alone can't say file vs
  // folder, and history state survives reloads. Next.js merges its own keys
  // into the object we pass (and keeps ours), so its popstate handling is unaffected.
  useEffect(() => {
    window.history.replaceState({ ...(window.history.state ?? {}), [HISTORY_KEY]: { folder: initialFolder, open: initialOpen ?? null } }, "");
  }, [initialFolder, initialOpen]);
  const urlFor = useCallback((next: Loc) => {
    const url = new URL(window.location.href);
    // A locked (unpaid) entry stays out of the URL: the page can't open a
    // paywalled file, so a reload would land on a payment-required listing
    // instead of this preview.
    const p = locationPath(next.folder, next.open && !next.open.locked ? next.open.path : null);
    if (p) url.searchParams.set("path", p); else url.searchParams.delete("path");
    return url.toString();
  }, []);
  // Folder navigation (closes any open file — the URL names one location)
  // pushes a history entry so the back button walks the folder hierarchy.
  const setPath = useCallback((folder: string) => {
    const next = { folder, open: null };
    openPushedRef.current = false;
    setLoc(next);
    const url = urlFor(next);
    if (url !== window.location.href) window.history.pushState({ [HISTORY_KEY]: next }, "", url);
  }, [urlFor]);
  const setSelected = useCallback((entry: DriveEntry | null) => {
    const next = { folder: loc.folder, open: entry };
    const url = urlFor(next);
    const step = viewerHistory({ openPushed: openPushedRef.current, opening: !!entry, urlChanged: url !== window.location.href });
    openPushedRef.current = step.openPushed;
    if (step.action === "back") { window.history.back(); return; } // popstate restores the folder
    setLoc(next);
    if (step.action === "push") window.history.pushState({ [HISTORY_KEY]: next }, "", url);
    if (step.action === "replace") window.history.replaceState({ ...(window.history.state ?? {}), [HISTORY_KEY]: next }, "", url);
  }, [loc.folder, urlFor]);
  // Sync state when the user hits Back/Forward. An entry without our Loc
  // (pushed before this page existed) can only have been a folder.
  useEffect(() => {
    const onPop = (ev: PopStateEvent) => {
      openPushedRef.current = false;
      const saved = (ev.state as Record<string, unknown> | null)?.[HISTORY_KEY] as Loc | undefined;
      setLoc(saved ?? { folder: new URL(window.location.href).searchParams.get("path") || "", open: null });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const [entries, setEntries] = useState<DriveEntry[]>([]);
  const [drives, setDrives] = useState<DriveSummary[]>([]);
  const [role, setRole] = useState<string>(initialRole ?? "viewer");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState<{ path: string; focus?: "sell" } | null>(null);
  const [shares, setShares] = useState<ShareSummary[]>([]);
  const [showcase, setShowcase] = useState<ShowcaseItem[]>([]);
  const [agentModalOpen, setAgentModalOpen] = useState(false);
  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // List/grid preference. Starts "list" so SSR + first client render agree
  // (no hydration mismatch); the persisted choice is read in an effect below.
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  useEffect(() => {
    const saved = localStorage.getItem("aindrive:view");
    if (saved === "list" || saved === "grid") setViewMode(saved);
  }, []);
  const changeViewMode = useCallback((v: ViewMode) => {
    setViewMode(v);
    localStorage.setItem("aindrive:view", v);
  }, []);
  // Sort preference — same SSR-safe pattern as viewMode (default first, read
  // the persisted choice in an effect).
  const [sort, setSortState] = useState<SortState>({ key: "name", dir: "asc" });
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("aindrive:sort") || "");
      if (saved && ["name", "mtime", "size"].includes(saved.key) && ["asc", "desc"].includes(saved.dir)) {
        setSortState(saved);
      }
    } catch { /* unset/corrupt → keep default */ }
  }, []);
  // Clicking the active column toggles direction; a new column starts asc.
  const onSort = useCallback((key: SortKey) => {
    setSortState((cur) => {
      const next: SortState = cur.key === key
        ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" };
      localStorage.setItem("aindrive:sort", JSON.stringify(next));
      return next;
    });
  }, []);
  // Folder-scoped filename search; navigating away clears it.
  const [query, setQuery] = useState("");
  useEffect(() => { setQuery(""); }, [path]);
  // Right-click context menu. entry=null → empty-area menu (New folder/Upload).
  const [ctxMenu, setCtxMenu] = useState<{ entry: DriveEntry | null; x: number; y: number } | null>(null);

  const isSyntheticRoot = !!entryItems && path === "";
  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    // Synthetic root (multi-grant member at ""): server-side root fs/list would
    // 403 — render the member's own grant entries instead. Role resets to
    // viewer: a grant-level role picked up inside a path must not leak edit
    // affordances back onto the synthetic listing (its rows are grant roots —
    // a stale editor role would even expose a working Delete on them).
    if (isSyntheticRoot && entryItems) {
      setEntries(entryItems);
      setRole("viewer");
      setLoading(false);
      return;
    }
    const res = await apiFetch<{ entries: DriveEntry[]; role: string }>(`/api/drives/${driveId}/fs/list?path=${encodeURIComponent(path)}`);
    if (!res.ok) { setErr(res.error || "failed to list"); setLoading(false); return; }
    setEntries(res.data.entries); setRole(res.data.role); setLoading(false);
  }, [driveId, path, entryItems, isSyntheticRoot]);

  const isOwner = role === "owner";

  const loadDrives = useCallback(async () => {
    const res = await apiFetch<{ drives: DriveSummary[] }>(`/api/drives`);
    if (res.ok) setDrives(res.data.drives);
  }, []);

  // Editors (not just owners) get the inline sale badges so someone editing a
  // file knows it's monetized. GET /shares is editor-at-root; a purely
  // path-scoped editor 403s → res.ok false → badges stay empty (tolerated).
  const loadShares = useCallback(async () => {
    if (role !== "editor" && role !== "owner") return;
    const res = await apiFetch<{ shares: ShareSummary[] }>(`/api/drives/${driveId}/shares`);
    if (res.ok) setShares(res.data.shares);
  }, [driveId, role]);

  // Upsell surface for non-owners; the owner skips it (their own listings are
  // all "covered" server-side anyway). !ok (403/404) is an expected outcome
  // for accounts the endpoint's relationship gate rejects — silently empty.
  const loadShowcase = useCallback(async () => {
    if (isOwner) return;
    const res = await apiFetch<{ items: ShowcaseItem[] }>(`/api/drives/${driveId}/showcase`);
    setShowcase(res.ok ? res.data.items : []);
  }, [driveId, isOwner]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadDrives(); }, [loadDrives]);
  useEffect(() => { loadShares(); }, [loadShares]);
  useEffect(() => { loadShowcase(); }, [loadShowcase]);

  // Map: path → paid share (most recent), for badge rendering and ⋮ menu state
  const paidByPath = useMemo(() => {
    const m = new Map<string, ShareSummary>();
    for (const s of shares) {
      if (s.price_usdc !== null && !m.has(s.path)) m.set(s.path, s);
    }
    return m;
  }, [shares]);

  // Filter → sort in one place so the list and grid consume the same array.
  const visibleEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;
    return sortEntries(filtered, sort.key, sort.dir);
  }, [entries, query, sort]);

  const canEdit = !isSyntheticRoot && (role === "editor" || role === "owner");
  const crumbs = useMemo(() => {
    if (entryItems) {
      // Synthetic mode: never emit clickable segments between "" and the grant
      // (the member has no access there — they'd be guaranteed 403 dead-ends).
      // Chain: driveName("") → whole grant as one crumb → segments below it.
      const acc: { label: string; path: string }[] = [{ label: driveName, path: "" }];
      if (path === "") return acc;
      const grant = entryItems.map((e) => e.path).find((g) => path === g || path.startsWith(g + "/"));
      if (!grant) { acc.push({ label: path, path }); return acc; }
      acc.push({ label: grant, path: grant });
      let cur = grant;
      for (const p of path.slice(grant.length).split("/").filter(Boolean)) {
        cur = `${cur}/${p}`; acc.push({ label: p, path: cur });
      }
      return acc;
    }
    // Visual root is scopeRoot — the highest folder this user may reach (their
    // grant, or the drive root) — not where they landed: a sub-path member
    // must not navigate above their grant, and a deep link must not trap an
    // owner below the root. Only render segments at-or-below scopeRoot.
    // If `path` is somehow not under `scopeRoot` (e.g. a stale popstate URL),
    // the breadcrumb chain is only cosmetically off — the server enforces
    // access on every API call, so no unauthorized data is exposed.
    const rel = scopeRoot && path.startsWith(scopeRoot + "/")
      ? path.slice(scopeRoot.length + 1)
      : path === scopeRoot ? "" : path;
    const parts = rel.split("/").filter(Boolean);
    const acc: { label: string; path: string }[] = [{ label: driveName, path: scopeRoot }];
    let cur = scopeRoot;
    for (const p of parts) { cur = cur ? `${cur}/${p}` : p; acc.push({ label: p, path: cur }); }
    return acc;
  }, [path, driveName, scopeRoot, entryItems]);

  async function onNewFolder() {
    const name = prompt("New folder name");
    if (!name) return;
    const target = path ? `${path}/${name}` : name;
    const res = await apiFetch(`/api/drives/${driveId}/fs/mkdir`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: target }),
    });
    if (!res.ok) alert(res.error); else load();
  }

  async function onUpload(files: FileList | null) {
    if (!files || !canEdit) return;
    const uploadedPaths: string[] = [];
    for (const file of Array.from(files)) {
      const target = path ? `${path}/${file.name}` : file.name;
      // Streamed raw-body upload (fs/upload re-chunks to the agent and
      // publishes atomically). XHR instead of fetch: the browser streams a
      // File body from disk without buffering it in JS, AND exposes upload
      // progress — fetch only does the former.
      const toastId = `upload-${target}`;
      toast.loading(`Uploading ${file.name} — 0%`, { id: toastId });
      const res = await uploadFile(driveId, target, file, (pct) => {
        toast.loading(`Uploading ${file.name} — ${pct}%`, { id: toastId });
      });
      toast.dismiss(toastId);
      if (!res.ok) toast.error(`${file.name}: ${res.error}`);
      else uploadedPaths.push(target);
    }
    load();
    if (uploadedPaths.length === 1) {
      const p = uploadedPaths[0];
      toast(`Uploaded "${p.split("/").pop()}"`, {
        action: {
          label: "Set price",
          onClick: () => setShareOpen({ path: p, focus: "sell" }),
        },
        duration: 7000,
      });
    } else if (uploadedPaths.length > 1) {
      toast.success(`Uploaded ${uploadedPaths.length} files`);
    }
  }

  async function onDelete(e: DriveEntry) {
    if (!canEdit) return;
    if (!confirm(`Delete "${e.name}"?`)) return;
    const res = await apiFetch(`/api/drives/${driveId}/fs/delete`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: e.path }),
    });
    if (!res.ok) toast.error(res.error); else load();
  }

  async function onRename(e: DriveEntry) {
    if (!canEdit) return;
    const newName = prompt("New name", e.name);
    if (!newName || newName === e.name) return;
    const parts = e.path.split("/"); parts[parts.length - 1] = newName;
    const res = await apiFetch(`/api/drives/${driveId}/fs/rename`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: e.path, to: parts.join("/") }),
    });
    if (!res.ok) toast.error(res.error); else load();
  }

  /**
   * Drag-move: drop an entry onto a folder row/card or a breadcrumb. Reuses the
   * rename RPC, which every agent (cli, Android SAF, iOS) implements as a
   * cross-directory move. `destDir` is the target directory path ("" = root).
   */
  async function onMove(entry: DriveEntry, destDir: string) {
    if (!canEdit) return;
    const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
    if (destDir === parent) return; // dropped where it already lives
    if (entry.isDir && (destDir === entry.path || destDir.startsWith(entry.path + "/"))) {
      toast.error("Can’t move a folder into itself");
      return;
    }
    const to = destDir ? `${destDir}/${entry.name}` : entry.name;
    const res = await apiFetch(`/api/drives/${driveId}/fs/rename`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: entry.path, to }),
    });
    if (!res.ok) { toast.error(res.error); return; }
    if (selected?.path === entry.path) setSelected(null);
    toast.success(`Moved "${entry.name}" to ${destDir ? destDir.split("/").pop() : driveName}`);
    load();
  }

  function onRowAction(entry: DriveEntry, action: "sell" | "share" | "rename" | "delete") {
    switch (action) {
      case "sell": return setShareOpen({ path: entry.path, focus: "sell" });
      case "share": return setShareOpen({ path: entry.path });
      case "rename": return onRename(entry);
      case "delete": return onDelete(entry);
    }
  }

  return (
    <div className="h-screen h-[100dvh] flex overflow-hidden">
      {sidebarOpen && (
        <button
          aria-label="Close menu"
          onClick={() => setSidebarOpen(false)}
          className="md:hidden fixed inset-0 z-30 bg-black/30"
        />
      )}
      <DriveSidebar
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
        onNewFolder={onNewFolder}
        onUpload={onUpload}
        canEdit={canEdit}
        drives={drives}
        driveId={driveId}
        role={role}
        onCreateAgent={() => setAgentModalOpen(true)}
        onOpenMcp={() => setMcpModalOpen(true)}
      />

      <main className="flex-1 flex flex-col min-w-0">
        <DriveHeader
          setSidebarOpen={setSidebarOpen}
          crumbs={crumbs}
          setPath={setPath}
          canEdit={canEdit}
          onUpload={onUpload}
          onNewFolder={onNewFolder}
          onMove={onMove}
          setShareOpen={setShareOpen}
          path={path}
          role={role}
          setChatOpen={setChatOpen}
          chatOpen={chatOpen}
          isOwner={isOwner}
          viewMode={viewMode}
          setViewMode={changeViewMode}
          query={query}
          onQuery={setQuery}
        />

        <section className="flex-1 flex min-h-0">
          <div className="flex-1 overflow-auto scrollbar-thin p-3 sm:p-6">
            <FileTable
              loading={loading}
              err={err}
              driveId={driveId}
              entries={visibleEntries}
              sort={sort}
              onSort={onSort}
              query={query}
              onQuery={setQuery}
              paidByPath={paidByPath}
              selected={selected}
              setSelected={setSelected}
              setPath={setPath}
              canEdit={canEdit}
              onRowAction={onRowAction}
              onMove={onMove}
              isOwner={isOwner}
              onUpload={onUpload}
              viewMode={viewMode}
              onNewFolder={onNewFolder}
              ctxMenu={ctxMenu}
              setCtxMenu={setCtxMenu}
            />
            {/* Entry views only (root/grant landing + synthetic root) — the
                showcase is a discovery surface, not deep-navigation chrome. */}
            {(path === scopeRoot || isSyntheticRoot) && <ShowcaseSection driveId={driveId} items={showcase} />}
          </div>
          {selected && (selected.locked ? (
            <LockedPreview
              driveId={driveId}
              entry={selected}
              onClose={() => setSelected(null)}
            />
          ) : (
            <Viewer
              driveId={driveId}
              entry={selected}
              canEdit={canEdit}
              onClose={() => setSelected(null)}
              onSaved={load}
            />
          ))}
          {chatOpen && (
            <FolderChat
              driveId={driveId}
              currentFolder={path}
              isOwner={isOwner}
              onClose={() => setChatOpen(false)}
            />
          )}
        </section>
      </main>

      {shareOpen && (
        <ShareDialog
          driveId={driveId}
          defaultPath={shareOpen.path}
          focusSection={shareOpen.focus}
          onClose={() => { setShareOpen(null); loadShares(); }}
        />
      )}
      {mcpModalOpen && <McpModal driveId={driveId} onClose={() => setMcpModalOpen(false)} />}
      {agentModalOpen && (
        <CreateAgentModal
          driveId={driveId}
          defaultFolder={path}
          onClose={() => setAgentModalOpen(false)}
        />
      )}
    </div>
  );
}

// Single-file upload with progress. Resolves (never rejects) so the caller's
// per-file loop continues past failures. Files over one part go through the
// chunked/resumable session flow — a single giant POST dies on whichever
// proxy/runtime body-size or time limit it meets first (nginx caps, Node
// requestTimeout), while ≤8 MiB parts pass them all and survive retries.
const UPLOAD_PART_BYTES = 8 * 1024 * 1024; // server-declared; create response can override

function uploadFile(
  driveId: string,
  target: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (file.size <= UPLOAD_PART_BYTES) return uploadSmall(driveId, target, file, onProgress);
  return uploadChunked(driveId, target, file, onProgress);
}

function uploadSmall(
  driveId: string,
  target: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/drives/${driveId}/fs/upload?path=${encodeURIComponent(target)}`);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve({ ok: true });
      let error = `upload failed (${xhr.status})`;
      try { error = JSON.parse(xhr.responseText).error || error; } catch {}
      resolve({ ok: false, error });
    };
    xhr.onerror = () => resolve({ ok: false, error: "network error" });
    // Without this, an aborted XHR settles nothing and the multi-file loop
    // awaits forever (with its loading toast pinned).
    xhr.onabort = () => resolve({ ok: false, error: "upload cancelled" });
    xhr.send(file);
  });
}

// Chunked + resumable: sequential ≤partSize PATCHes against a server session;
// the server's receivedBytes (verified against the agent temp file) is the
// only truth — on any disagreement (409) or failure the client re-syncs and
// re-slices from it. The session id is remembered per (drive, path, file
// fingerprint) so re-dropping the same file resumes instead of restarting.
async function uploadChunked(
  driveId: string,
  target: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const base = `/api/drives/${driveId}/fs/upload-sessions`;
  const resumeKey = `aindrive-upload:${driveId}:${target}:${file.size}:${file.lastModified}`;

  // Resume if we hold a live session for this exact file, else open one.
  let uploadId = localStorage.getItem(resumeKey);
  let offset = 0;
  let partSize = UPLOAD_PART_BYTES;
  if (uploadId) {
    const st = await apiFetch<{ receivedBytes: number; partSize: number }>(`${base}/${uploadId}`);
    if (st.ok) { offset = st.data.receivedBytes; partSize = st.data.partSize; }
    else { localStorage.removeItem(resumeKey); uploadId = null; }
  }
  if (!uploadId) {
    const res = await apiFetch<{ uploadId: string; partSize: number }>(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: target, size: file.size }),
    });
    if (!res.ok) return { ok: false, error: res.error || "failed to start upload" };
    uploadId = res.data.uploadId;
    partSize = res.data.partSize;
    localStorage.setItem(resumeKey, uploadId);
  }

  let failures = 0;
  for (;;) {
    // offset === size yields an empty part = the rename-retry signal.
    const part = file.slice(offset, Math.min(offset + partSize, file.size));
    const r = await sendPart(driveId, uploadId, offset, part, (loaded) =>
      onProgress(Math.min(99, Math.round(((offset + loaded) / file.size) * 100))),
    );
    if (r.ok) {
      failures = 0;
      offset = r.receivedBytes;
      if (r.complete) {
        localStorage.removeItem(resumeKey);
        onProgress(100);
        return { ok: true };
      }
      continue;
    }
    if (r.status === 409 && typeof r.receivedBytes === "number") {
      offset = r.receivedBytes; // server truth; re-slice from there
      failures += 1;            // still counts — a 409 loop must terminate
    } else if (r.status === 404 || r.status === 410) {
      // Session gone (completed elsewhere / temp lost / TTL-swept): the old
      // uploadId is dead — open a fresh session and start over.
      failures += 1;
      localStorage.removeItem(resumeKey);
      const res = await apiFetch<{ uploadId: string; partSize: number }>(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: target, size: file.size }),
      });
      if (!res.ok) return { ok: false, error: res.error || r.error };
      uploadId = res.data.uploadId;
      partSize = res.data.partSize;
      offset = 0;
      localStorage.setItem(resumeKey, uploadId);
    } else {
      failures += 1;
      if (failures <= 5) {
        // Transient (network blip, agent hiccup): back off, re-sync offset.
        await new Promise((res) => setTimeout(res, 1000 * 2 ** Math.min(failures, 4)));
        const st = await apiFetch<{ receivedBytes: number }>(`${base}/${uploadId}`);
        if (st.ok) offset = st.data.receivedBytes;
      }
    }
    if (failures > 5) {
      // Keep the resume key: re-dropping the same file continues from offset.
      return { ok: false, error: r.error };
    }
  }
}

function sendPart(
  driveId: string,
  uploadId: string,
  offset: number,
  part: Blob,
  onLoaded: (loaded: number) => void,
): Promise<
  | { ok: true; complete: boolean; receivedBytes: number }
  | { ok: false; status: number; error: string; receivedBytes?: number }
> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PATCH", `/api/drives/${driveId}/fs/upload-sessions/${uploadId}`);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("x-upload-offset", String(offset));
    xhr.upload.onprogress = (e) => onLoaded(e.loaded);
    xhr.onload = () => {
      let data: { complete?: boolean; receivedBytes?: number; error?: string } | null = null;
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && data && typeof data.receivedBytes === "number") {
        return resolve({ ok: true, complete: !!data.complete, receivedBytes: data.receivedBytes });
      }
      resolve({
        ok: false, status: xhr.status,
        error: data?.error || `part failed (${xhr.status})`,
        receivedBytes: typeof data?.receivedBytes === "number" ? data.receivedBytes : undefined,
      });
    };
    xhr.onerror = () => resolve({ ok: false, status: 0, error: "network error" });
    xhr.onabort = () => resolve({ ok: false, status: 0, error: "upload cancelled" });
    xhr.send(part);
  });
}
