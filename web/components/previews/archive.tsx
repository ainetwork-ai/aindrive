"use client";
// Archive preview (zip, rar, 7z, tar, gz, bz2, xz): a folder tree like Google
// Drive's, and clicking a file extracts just that entry and previews it inline
// through the same dispatcher the Viewer uses — so nested archives, images,
// PDFs etc. inside an archive all work without a server round-trip.
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChevronRight, Download, Folder, Lock } from "lucide-react";
import clsx from "clsx";
import { previewKindFor } from "@/lib/preview-kind";
import type { PreviewProps, PreviewSource } from "./types";
import { usePreviewBytes } from "./use-preview-bytes";
import { PreviewLoading, PreviewMessage, NO_PREVIEW } from "./status";
import { PreviewBody, hasInlineRenderer } from "./index";
import { fileIconForName } from "../file-icons";
import { openArchive, type ArchiveItem, type OpenedArchive } from "./archive-open";

function prettyBytes(n: number) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

type Node = { name: string; path: string; isDir: boolean; size: number; children: Node[] };

/** Flat entry list → sorted tree; synthesizes folders the archive didn't list. */
function buildTree(items: ArchiveItem[]): Node[] {
  const root: Node = { name: "", path: "", isDir: true, size: 0, children: [] };
  const dirs = new Map<string, Node>([["", root]]);
  const dir = (path: string): Node => {
    let d = dirs.get(path);
    if (d) return d;
    const cut = path.lastIndexOf("/");
    const parent = dir(cut < 0 ? "" : path.slice(0, cut));
    d = { name: path.slice(cut + 1), path, isDir: true, size: 0, children: [] };
    parent.children.push(d);
    dirs.set(path, d);
    return d;
  };
  for (const it of items) {
    if (it.isDir) { dir(it.path); continue; }
    const cut = it.path.lastIndexOf("/");
    dir(cut < 0 ? "" : it.path.slice(0, cut)).children.push({
      name: it.path.slice(cut + 1), path: it.path, isDir: false, size: it.size, children: [],
    });
  }
  const sort = (n: Node) => {
    n.children.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

export default function ArchivePreview({ src }: PreviewProps) {
  const bytes = usePreviewBytes(src);
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; archive: OpenedArchive }>({ status: "loading" });
  const [open, setOpen] = useState<ArchiveItem | null>(null);

  useEffect(() => {
    if (bytes.status !== "ready") return;
    let cancelled = false;
    let opened: OpenedArchive | null = null;
    setState({ status: "loading" });
    openArchive(src.name, bytes.data).then(
      (a) => { opened = a; if (cancelled) a.close(); else setState({ status: "ready", archive: a }); },
      (e: unknown) => { if (!cancelled) setState({ status: "error", message: e instanceof Error ? e.message : "Could not open the archive." }); },
    );
    return () => { cancelled = true; opened?.close(); };
  }, [bytes, src.name]);

  if (bytes.status === "error") return <PreviewMessage name={src.name} message={bytes.message} />;
  if (state.status === "error") return <PreviewMessage name={src.name} message={state.message} />;
  if (bytes.status === "loading" || state.status === "loading") return <PreviewLoading label="Opening archive…" />;
  const archive = state.archive;
  if (open) return <EntryView archive={archive} item={open} onBack={() => setOpen(null)} />;
  return <Listing archive={archive} onOpen={setOpen} />;
}

function Listing({ archive, onOpen }: { archive: OpenedArchive; onOpen: (it: ArchiveItem) => void }) {
  const tree = useMemo(() => buildTree(archive.items), [archive]);
  const files = archive.items.filter((i) => !i.isDir);
  const total = files.reduce((s, i) => s + i.size, 0);
  // A single top-level folder (the usual "project/" wrapper) starts expanded.
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(tree.length === 1 && tree[0].isDir ? [tree[0].path] : []),
  );
  const toggle = (p: string) =>
    setExpanded((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });

  const rows: Array<{ node: Node; depth: number }> = [];
  const walk = (nodes: Node[], depth: number) => {
    for (const node of nodes) {
      rows.push({ node, depth });
      if (node.isDir && expanded.has(node.path)) walk(node.children, depth + 1);
    }
  };
  walk(tree, 0);

  return (
    <div className="min-h-full">
      <div className="sticky top-0 z-10 bg-drive-panel border-b border-drive-border px-4 py-2 text-caption text-drive-muted flex items-center gap-2">
        <span>{files.length} {files.length === 1 ? "file" : "files"} · {prettyBytes(total)} uncompressed</span>
        {archive.encrypted && (
          <span className="ml-auto inline-flex items-center gap-1 text-amber-700"><Lock className="w-3.5 h-3.5" /> Encrypted</span>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="p-6 text-center text-caption text-drive-muted">This archive is empty.</p>
      ) : (
        <ul className="py-1" role="tree">
          {rows.map(({ node, depth }) => {
            const { Icon, className: tone } = node.isDir
              ? { Icon: Folder, className: "text-drive-muted" }
              : fileIconForName(node.name);
            const isOpen = expanded.has(node.path);
            return (
              <li key={node.path} role="treeitem" aria-expanded={node.isDir ? isOpen : undefined}>
                <button
                  type="button"
                  onClick={() => (node.isDir ? toggle(node.path) : onOpen({ path: node.path, isDir: false, size: node.size }))}
                  className="w-full flex items-center gap-2 pr-4 py-1.5 text-left text-body text-drive-text hover:bg-drive-hover"
                  style={{ paddingLeft: 12 + depth * 18 }}
                  title={node.path}
                >
                  <ChevronRight className={clsx("w-4 h-4 shrink-0 text-drive-muted transition-transform", !node.isDir && "invisible", isOpen && "rotate-90")} />
                  <Icon className={clsx("w-4 h-4 shrink-0", tone)} />
                  <span className="flex-1 min-w-0 truncate">{node.name}</span>
                  {!node.isDir && <span className="shrink-0 text-caption text-drive-muted tabular-nums">{prettyBytes(node.size)}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const MAX_TEXT_CHARS = 2 * 1024 * 1024;

function EntryView({ archive, item, onBack }: { archive: OpenedArchive; item: ArchiveItem; onBack: () => void }) {
  const name = item.path.slice(item.path.lastIndexOf("/") + 1);
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; blob: Blob; url: string }>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    archive.extract(item.path).then(
      (blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setState({ status: "ready", blob, url });
      },
      (e: unknown) => { if (!cancelled) setState({ status: "error", message: e instanceof Error ? e.message : "Could not extract this entry." }); },
    );
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [archive, item.path]);

  const inner = useMemo<PreviewSource | null>(() => {
    if (state.status !== "ready") return null;
    const { blob, url } = state;
    return { name, url, size: blob.size, bytes: () => blob.arrayBuffer() };
  }, [state, name]);

  const kind = previewKindFor(name);
  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 flex items-center gap-2 border-b border-drive-border bg-drive-panel px-2 py-1.5">
        <button type="button" onClick={onBack} className="p-1.5 rounded-full hover:bg-drive-hover text-drive-muted" title="Back to archive" aria-label="Back to archive">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <span className="flex-1 min-w-0 truncate text-caption text-drive-text" title={item.path}>{item.path}</span>
        {state.status === "ready" && (
          <a href={state.url} download={name} className="p-1.5 rounded-full hover:bg-drive-hover text-drive-muted" title={`Download ${name}`} aria-label={`Download ${name}`}>
            <Download className="w-4 h-4" />
          </a>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {state.status === "error" ? (
          <PreviewMessage name={name} message={state.message} />
        ) : !inner ? (
          <PreviewLoading label="Extracting…" />
        ) : kind === "text" || kind === "markdown" ? (
          <TextBody src={inner} />
        ) : hasInlineRenderer(kind) ? (
          <PreviewBody key={inner.url} kind={kind} src={inner} />
        ) : (
          <PreviewMessage name={name} message={NO_PREVIEW} />
        )}
      </div>
    </div>
  );
}

// Text/markdown members: the Viewer's editors are bound to drive files (Yjs),
// so an archive member gets a plain read-only view instead.
function TextBody({ src }: { src: PreviewSource }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    src.bytes().then((buf) => {
      if (!cancelled) setText(new TextDecoder("utf-8").decode(buf.slice(0, MAX_TEXT_CHARS)));
    });
    return () => { cancelled = true; };
  }, [src]);
  if (text === null) return <PreviewLoading />;
  return (
    <div>
      <pre className="p-4 text-[12px] leading-5 font-mono text-drive-text whitespace-pre-wrap break-words">{text}</pre>
      {src.size > MAX_TEXT_CHARS && (
        <p className="px-4 pb-4 text-caption text-drive-muted">Showing the first {prettyBytes(MAX_TEXT_CHARS)} — download for the full file.</p>
      )}
    </div>
  );
}
