"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import Link from "next/link";
import clsx from "clsx";
import { toast } from "sonner";
import {
  ChevronRight, Folder, FileText, FileCode, FileImage, File as FileIcon,
  FolderPlus, Upload, Share2, Loader2, HardDrive, DollarSign,
  Bot, MessageSquare,
} from "lucide-react";
import type { DriveEntry } from "@/lib/protocol";
import { Viewer } from "./viewer";
import { ShareDialog } from "./share-dialog";
import { RowMenu } from "./row-menu";
import { CreateAgentModal } from "./create-agent-modal";
import { FolderChat } from "./folder-chat";

type Props = { driveId: string; driveName: string };

type ShareSummary = {
  id: string;
  token: string;
  path: string;
  role: string;
  price_usdc: number | null;
};

export function DriveShell({ driveId, driveName }: Props) {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<DriveEntry[]>([]);
  const [role, setRole] = useState<string>("viewer");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<DriveEntry | null>(null);
  const [shareOpen, setShareOpen] = useState<{ path: string; focus?: "sell" } | null>(null);
  const [shares, setShares] = useState<ShareSummary[]>([]);
  const [agentModalOpen, setAgentModalOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    const res = await fetch(`/api/drives/${driveId}/fs/list?path=${encodeURIComponent(path)}`);
    if (!res.ok) { setErr((await res.json()).error || "failed to list"); setLoading(false); return; }
    const { entries, role } = await res.json();
    setEntries(entries); setRole(role); setLoading(false);
  }, [driveId, path]);

  const loadShares = useCallback(async () => {
    const res = await fetch(`/api/drives/${driveId}/shares`);
    if (res.ok) setShares((await res.json()).shares);
  }, [driveId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadShares(); }, [loadShares]);

  // Map: path → paid share (most recent), for badge rendering and ⋮ menu state
  const paidByPath = useMemo(() => {
    const m = new Map<string, ShareSummary>();
    for (const s of shares) {
      if (s.price_usdc !== null && !m.has(s.path)) m.set(s.path, s);
    }
    return m;
  }, [shares]);

  const canEdit = role === "editor" || role === "owner";
  const crumbs = useMemo(() => {
    const parts = path.split("/").filter(Boolean);
    const acc: { label: string; path: string }[] = [{ label: driveName, path: "" }];
    let cur = "";
    for (const p of parts) { cur = cur ? `${cur}/${p}` : p; acc.push({ label: p, path: cur }); }
    return acc;
  }, [path, driveName]);

  async function onNewFolder() {
    const name = prompt("New folder name");
    if (!name) return;
    const target = path ? `${path}/${name}` : name;
    const res = await fetch(`/api/drives/${driveId}/fs/mkdir`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: target }),
    });
    if (!res.ok) alert((await res.json()).error); else load();
  }

  async function onUpload(files: FileList | null) {
    if (!files || !canEdit) return;
    const uploadedPaths: string[] = [];
    for (const file of Array.from(files)) {
      const arr = await file.arrayBuffer();
      const b64 = arrayBufferToBase64(arr);
      const target = path ? `${path}/${file.name}` : file.name;
      const res = await fetch(`/api/drives/${driveId}/fs/write`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: target, content: b64, encoding: "base64" }),
      });
      if (!res.ok) toast.error(`${file.name}: ${(await res.json()).error}`);
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
    const res = await fetch(`/api/drives/${driveId}/fs/delete`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: e.path }),
    });
    if (!res.ok) toast.error((await res.json()).error); else load();
  }

  async function onRename(e: DriveEntry) {
    if (!canEdit) return;
    const newName = prompt("New name", e.name);
    if (!newName || newName === e.name) return;
    const parts = e.path.split("/"); parts[parts.length - 1] = newName;
    const res = await fetch(`/api/drives/${driveId}/fs/rename`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: e.path, to: parts.join("/") }),
    });
    if (!res.ok) toast.error((await res.json()).error); else load();
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
    <div className="h-screen flex overflow-hidden">
      <aside className="hidden md:flex flex-col w-64 bg-drive-sidebar border-r border-drive-border p-4 gap-2">
        <Link href="/" className="flex items-center gap-2 font-semibold text-lg px-2 py-1.5">
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
        <nav className="mt-3 text-sm">
          <div className={clsx("flex items-center gap-2 px-3 py-2 rounded-full", !path && "bg-drive-selected")}>
            <Folder className="w-4 h-4" />
            <button onClick={() => setPath("")} className="truncate">{driveName}</button>
          </div>
        </nav>
        <div className="mt-auto text-xs text-drive-muted px-2">Role: {role}</div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        <header className="flex items-center justify-between gap-3 px-6 py-3 border-b border-drive-border bg-white">
          <div className="flex items-center gap-1 min-w-0 text-sm">
            {crumbs.map((c, i) => (
              <span key={c.path} className="flex items-center gap-1 min-w-0">
                {i > 0 && <ChevronRight className="w-4 h-4 text-drive-muted shrink-0" />}
                <button onClick={() => setPath(c.path)} className="truncate hover:underline">{c.label}</button>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <label className={clsx("cursor-pointer flex items-center gap-2 rounded-full px-3 py-1.5 text-sm border border-drive-border hover:bg-drive-hover", !canEdit && "opacity-50 pointer-events-none")}>
              <Upload className="w-4 h-4" /> Upload
              <input type="file" multiple hidden onChange={(e) => onUpload(e.target.files)} />
            </label>
            <button
              onClick={() => setShareOpen({ path })}
              className="flex items-center gap-2 rounded-full bg-drive-accent text-white px-3 py-1.5 text-sm hover:bg-drive-accentHover"
            >
              <Share2 className="w-4 h-4" /> Share
            </button>
            {role === "owner" && (
              <button
                onClick={() => setAgentModalOpen(true)}
                title="Create Agent"
                className="flex items-center gap-2 rounded-full border border-drive-border px-3 py-1.5 text-sm hover:bg-drive-hover"
              >
                <Bot className="w-4 h-4" /> Agent
              </button>
            )}
            <button
              onClick={() => setChatOpen((v) => !v)}
              title="Folder chat"
              className={clsx(
                "flex items-center gap-2 rounded-full border border-drive-border px-3 py-1.5 text-sm hover:bg-drive-hover",
                chatOpen && "bg-blue-50 border-blue-300",
              )}
            >
              <MessageSquare className="w-4 h-4" />
            </button>
          </div>
        </header>

        <section className="flex-1 flex min-h-0">
          <div className="flex-1 overflow-auto scrollbar-thin p-6">
            {loading ? (
              <div className="flex items-center justify-center text-drive-muted gap-2 py-20">
                <Loader2 className="w-4 h-4 animate-spin" /> connecting to your agent…
              </div>
            ) : err ? (
              <div className="text-center text-red-600 py-20">{err}</div>
            ) : entries.length === 0 ? (
              <div className="text-center text-drive-muted py-20">This folder is empty.</div>
            ) : (
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
                        <td className="py-2 flex items-center gap-3 min-w-0">
                          <EntryIcon entry={e} />
                          <span className="truncate">{e.name}</span>
                          {paid && (
                            <span
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-green-50 text-green-700 text-[11px] font-medium border border-green-200"
                              title={`Selling at $${paid.price_usdc?.toFixed(2)} USDC`}
                            >
                              <DollarSign className="w-3 h-3" />
                              {paid.price_usdc?.toFixed(2)}
                            </span>
                          )}
                        </td>
                        <td className="py-2 hidden sm:table-cell text-drive-muted">
                          {new Date(e.mtimeMs).toLocaleString()}
                        </td>
                        <td className="py-2 hidden md:table-cell text-right text-drive-muted">
                          {e.isDir ? "—" : prettyBytes(e.size)}
                        </td>
                        <td className="py-2 text-right whitespace-nowrap">
                          {canEdit && (
                            <RowMenu
                              hasPaidShare={!!paid}
                              onAction={(a) => onRowAction(e, a)}
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
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
              isOwner={role === "owner"}
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

function EntryIcon({ entry }: { entry: DriveEntry }) {
  if (entry.isDir) return <Folder className="w-5 h-5 text-drive-accent shrink-0" />;
  if (entry.mime.startsWith("image/")) return <FileImage className="w-5 h-5 text-drive-muted shrink-0" />;
  if (/\.(ts|tsx|js|jsx|py|rs|go|html|css|json)$/.test(entry.name)) return <FileCode className="w-5 h-5 text-drive-muted shrink-0" />;
  if (entry.mime.startsWith("text/")) return <FileText className="w-5 h-5 text-drive-muted shrink-0" />;
  return <FileIcon className="w-5 h-5 text-drive-muted shrink-0" />;
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

function prettyBytes(n: number) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
