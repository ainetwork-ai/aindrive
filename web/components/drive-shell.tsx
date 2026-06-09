"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { toast } from "sonner";
import type { DriveEntry } from "@/lib/protocol";
import type { ShowcaseItem } from "@/lib/showcase";
import { apiFetch } from "@/lib/api-client";
import {
  DriveSidebar, DriveHeader, FileTable, ShowcaseSection,
  type DriveSummary, type ShareSummary,
} from "./drive-shell-parts";

// These four are only rendered on user action (open a file, open chat, open
// the share/agent modal), so we load them on demand instead of bundling them
// into the drive workspace's initial JS. Viewer is the heaviest — it pulls in
// the Monaco editor, y-monaco, and the Yjs provider. ssr:false because they're
// interactive client-only surfaces with no SSR value.
const Viewer = dynamic(() => import("./viewer").then((m) => m.Viewer), { ssr: false });
const ShareDialog = dynamic(() => import("./share-dialog").then((m) => m.ShareDialog), { ssr: false });
const CreateAgentModal = dynamic(() => import("./create-agent-modal").then((m) => m.CreateAgentModal), { ssr: false });
const FolderChat = dynamic(() => import("./folder-chat").then((m) => m.FolderChat), { ssr: false });

type Props = {
  driveId: string;
  driveName: string;
  initialPath?: string;
  initialRole?: string;
  /** Multi-grant member's accessible entries; "" renders these instead of fs/list (synthetic root). */
  entryItems?: DriveEntry[];
};

export function DriveShell({ driveId, driveName, initialPath, initialRole, entryItems }: Props) {
  const [path, setPathState] = useState(() => {
    if (initialPath !== undefined) return initialPath;
    if (typeof window === "undefined") return "";
    const url = new URL(window.location.href);
    return url.searchParams.get("path") || "";
  });
  // Wrap setPath so every folder navigation pushes a history entry — this
  // makes the browser/system back button (especially on mobile) walk the
  // folder hierarchy instead of leaving the drive.
  const setPath = useCallback((next: string) => {
    setPathState((prev) => {
      if (next === prev) return prev;
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        if (next) url.searchParams.set("path", next);
        else url.searchParams.delete("path");
        window.history.pushState(null, "", url.toString());
      }
      return next;
    });
  }, []);
  // Sync state when the user hits Back/Forward.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPop = () => {
      const url = new URL(window.location.href);
      setPathState(url.searchParams.get("path") || "");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const [entries, setEntries] = useState<DriveEntry[]>([]);
  const [drives, setDrives] = useState<DriveSummary[]>([]);
  const [role, setRole] = useState<string>(initialRole ?? "viewer");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<DriveEntry | null>(null);
  const [shareOpen, setShareOpen] = useState<{ path: string; focus?: "sell" } | null>(null);
  const [shares, setShares] = useState<ShareSummary[]>([]);
  const [showcase, setShowcase] = useState<ShowcaseItem[]>([]);
  const [agentModalOpen, setAgentModalOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

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

  const loadShares = useCallback(async () => {
    if (!isOwner) return;
    const res = await apiFetch<{ shares: ShareSummary[] }>(`/api/drives/${driveId}/shares`);
    if (res.ok) setShares(res.data.shares);
  }, [driveId, isOwner]);

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

  const canEdit = !isSyntheticRoot && (role === "editor" || role === "owner");
  const rootPath = initialPath ?? "";
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
    // Visual root is the member's grant (rootPath), not the drive root: a
    // sub-path member must not be able to navigate above what they were
    // granted. Only render segments at-or-below rootPath.
    // If `path` is somehow not under `rootPath` (e.g. a stale popstate URL),
    // the breadcrumb chain is only cosmetically off — the server enforces
    // access on every API call, so no unauthorized data is exposed.
    const rel = rootPath && path.startsWith(rootPath + "/")
      ? path.slice(rootPath.length + 1)
      : path === rootPath ? "" : path;
    const parts = rel.split("/").filter(Boolean);
    const acc: { label: string; path: string }[] = [{ label: driveName, path: rootPath }];
    let cur = rootPath;
    for (const p of parts) { cur = cur ? `${cur}/${p}` : p; acc.push({ label: p, path: cur }); }
    return acc;
  }, [path, driveName, rootPath, entryItems]);

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
      const arr = await file.arrayBuffer();
      const b64 = arrayBufferToBase64(arr);
      const target = path ? `${path}/${file.name}` : file.name;
      const res = await apiFetch(`/api/drives/${driveId}/fs/write`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: target, content: b64, encoding: "base64" }),
      });
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
        canEdit={canEdit}
        drives={drives}
        driveId={driveId}
        role={role}
      />

      <main className="flex-1 flex flex-col min-w-0">
        <DriveHeader
          setSidebarOpen={setSidebarOpen}
          crumbs={crumbs}
          setPath={setPath}
          canEdit={canEdit}
          onUpload={onUpload}
          setShareOpen={setShareOpen}
          path={path}
          role={role}
          setAgentModalOpen={setAgentModalOpen}
          setChatOpen={setChatOpen}
          chatOpen={chatOpen}
          isOwner={isOwner}
        />

        <section className="flex-1 flex min-h-0">
          <div className="flex-1 overflow-auto scrollbar-thin p-3 sm:p-6">
            <FileTable
              loading={loading}
              err={err}
              entries={entries}
              paidByPath={paidByPath}
              selected={selected}
              setSelected={setSelected}
              setPath={setPath}
              canEdit={canEdit}
              onRowAction={onRowAction}
              isOwner={isOwner}
            />
            {/* Entry views only (root/grant landing + synthetic root) — the
                showcase is a discovery surface, not deep-navigation chrome. */}
            {(path === rootPath || isSyntheticRoot) && <ShowcaseSection items={showcase} />}
          </div>
          {selected && (
            <Viewer
              driveId={driveId}
              entry={selected}
              canEdit={canEdit}
              onClose={() => setSelected(null)}
              onSaved={load}
            />
          )}
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

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
