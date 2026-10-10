"use client";
// Collaborative WYSIWYG Markdown editor (TipTap v3 + Yjs).
//
// SAFETY / DATA-LOSS CONTRACT (see specs/2026-06-10-editor-framework-design.md):
//  - Binds TipTap to a SEPARATE Y.Doc root — getXmlFragment("prosemirror") — NOT
//    the Y.Text("content") root that Monaco uses. A .md file opens THIS editor or
//    Monaco, never both, so the two roots never collide.
//  - Disk round-trip is Markdown: serialize via editor.getMarkdown(), seed via
//    setContent(md, {contentType:"markdown"}). The Y.Text("content") path is
//    never touched here, so the markdown file's disk write can't serialize an
//    empty/ wrong root.
//  - reloadEquals compares CANONICAL vs CANONICAL (getMarkdown is a normalizing
//    serializer, so raw-disk byte compare would loop forever): canon(disk) ===
//    canon(current). Only a genuine external change re-seeds.
//  - The disk is consulted on EVERY open (lib/doc-disk-sync.ts): an empty
//    fragment seeds from it; a stored fragment that disagrees with the disk is
//    kept only when the disk still holds what this browser last loaded/wrote
//    (our own unsaved edit) — otherwise the disk changed externally and wins.
//  - Nothing is written without a LOCAL edit. Seed, reload and sync updates are
//    not edits. Opening/closing a file never rewrites it.
//  - Writes are source-preserving (lib/markdown-preserve.ts): blocks the user
//    did not touch keep their original lines, and constructs the serializer
//    cannot represent (tables — no table extension) are kept, never dropped.
import { useEffect, useRef, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { Markdown } from "@tiptap/markdown";
import { useDebouncedCallback } from "use-debounce";
import * as Y from "yjs";
import {
  Bold, Italic, Heading1, Heading2, List, ListOrdered, Code, Quote, Undo2, Redo2,
} from "lucide-react";
import { AindriveProvider } from "@/lib/yjs/aindrive-provider";
import {
  createDiskSync, decideOnOpen, hashText, loadKnownDiskHash, markLoaded, noteUpdate,
  shouldReloadFromDisk, storeKnownDiskHash, type DiskSyncState,
} from "@/lib/doc-disk-sync";
import { mergePreservingSource } from "@/lib/markdown-preserve";
import { colorForId, sha1Base64, bytesToBase64 } from "../viewer-utils";
import type { DriveEntry } from "@/lib/protocol";
import clsx from "clsx";

type Presence = { id: number; name: string; color: string };

/** Canonicalize markdown by round-tripping through the editor's serializer, so
 *  the reload loop-guard compares normalized form (getMarkdown is normalizing). */
function canon(editor: Editor, md: string): string {
  try {
    return editor.storage.markdown ? (editor.markdown?.serialize(editor.markdown.parse(md)) ?? md) : md;
  } catch {
    return md;
  }
}

export function RichTextEditor({
  driveId, entry, canEdit, onStatus, onPresence,
}: {
  driveId: string;
  entry: DriveEntry;
  canEdit: boolean;
  onStatus: (s: "connecting" | "connected" | "offline") => void;
  onPresence: (p: Presence[]) => void;
}) {
  // One provider per file (component is keyed by path in the Viewer → remounts).
  // Held in a ref and recreated if destroyed: React StrictMode (dev) double-mounts
  // components, and the destroy-effect below kills the provider on the throwaway
  // unmount — without this recreate, the remount would reuse a dead provider whose
  // whenReady never resolves (editor stuck "connecting"). useEditor's [provider]
  // dep recreates the editor when a fresh provider is made.
  const providerRef = useRef<AindriveProvider | null>(null);
  if (!providerRef.current || providerRef.current.isDestroyed) {
    providerRef.current = new AindriveProvider(driveId, entry.path);
  }
  const provider = providerRef.current;
  const docIdRef = useRef<string>("");
  // Autosave is armed only AFTER the seed completes. Before then the editor's
  // bind inserts an empty paragraph (a doc update) — without this gate a slow
  // whenReady lets that empty state autosave to disk and wipe the file, and a
  // pure open→close would rewrite (re-canonicalize) the file with no edit.
  const readyToSaveRef = useRef(false);
  // The markdown exactly as it is on disk (last loaded or last written). The
  // autosave merges the editor's serialization against it so untouched blocks
  // keep their original text and unrepresentable blocks survive.
  const sourceRef = useRef<string>("");
  const diskSyncRef = useRef<DiskSyncState>(createDiskSync());
  // True while WE call setContent (seed / reload). y-prosemirror tags those
  // Y.Doc updates like typing, so the flag is what tells them apart.
  const programmaticRef = useRef(false);
  // Keep the parent callbacks in refs so the collab effect doesn't depend on
  // their identity — the parent passes inline arrows, and depending on them
  // would re-run the effect (→ refreshPresence → setState → re-render → loop).
  const onStatusRef = useRef(onStatus); onStatusRef.current = onStatus;
  const onPresenceRef = useRef(onPresence); onPresenceRef.current = onPresence;
  const seededRef = useRef(false);
  const [loading, setLoading] = useState(true);

  const editor = useEditor({
    editable: canEdit,
    immediatelyRender: false, // Next.js SSR safety
    extensions: [
      // Collaboration provides Yjs-backed history → StarterKit's own undo/redo
      // MUST be off or the two histories corrupt each other.
      StarterKit.configure({ undoRedo: false }),
      Collaboration.configure({ document: provider.doc, field: "prosemirror" }),
      CollaborationCaret.configure({ provider: { awareness: provider.awareness } }),
      Markdown,
    ],
    editorProps: {
      attributes: { class: "tiptap-prose focus:outline-hidden min-h-full px-5 py-4" },
    },
  }, [provider]);

  /** Replace the editor content from disk text without arming autosave. */
  function setFromDisk(ed: Editor, text: string, replaced: boolean) {
    programmaticRef.current = true;
    try { ed.commands.setContent(text, { contentType: "markdown" } as never); }
    finally { programmaticRef.current = false; }
    sourceRef.current = text;
    diskSyncRef.current = markLoaded(diskSyncRef.current, text, { replaced });
    storeKnownDiskHash(driveId, entry.path, diskSyncRef.current.lastDiskHash);
  }

  // Debounced autosave: markdown body to disk + full Yjs update to the store.
  const debouncedAutosave = useDebouncedCallback(async () => {
    if (!canEdit || !editor || !docIdRef.current || !readyToSaveRef.current) return;
    // No local edit since the last load/write → nothing to persist. (Opening a
    // file, a sync from a peer or an fs-changed reload never reach here.)
    if (!diskSyncRef.current.dirty) return;
    // Source-preserving: untouched blocks keep their disk text; a table (which
    // the serializer drops) stays in place. Only edited blocks are re-serialized.
    const blockCanon = (b: string) => canon(editor, b);
    const md = mergePreservingSource(sourceRef.current, editor.getMarkdown(), blockCanon);
    if (md === sourceRef.current) { diskSyncRef.current = { ...diskSyncRef.current, dirty: false }; return; }
    const update = Y.encodeStateAsUpdate(provider.doc);
    try {
      const [w] = await Promise.all([
        fetch(`/api/drives/${driveId}/fs/write`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: entry.path, content: md, encoding: "utf8", source: "autosave" }),
        }),
        fetch(`/api/drives/${driveId}/yjs`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: entry.path, data: bytesToBase64(update) }),
        }),
      ]);
      if (w.ok) {
        sourceRef.current = md;
        diskSyncRef.current = markLoaded(diskSyncRef.current, md);
        storeKnownDiskHash(driveId, entry.path, diskSyncRef.current.lastDiskHash);
      }
    } catch (e) { console.warn("richtext autosave failed:", e); }
  }, 5000, { maxWait: 15000 });

  // Collab lifecycle: status, identity, presence, seed-from-disk, reload, autosave.
  useEffect(() => {
    if (!editor) return;
    let cancelled = false;

    const off = provider.on(async (ev) => {
      if (cancelled) return;
      if (ev === "status") onStatusRef.current(provider.status);
      if (ev === "reload") {
        // External tool changed the .md on disk → the disk wins, but only if
        // the change is real. canon-vs-canon avoids the autosave→watch→reload loop.
        try {
          const res = await fetch(`/api/drives/${driveId}/fs/read?path=${encodeURIComponent(entry.path)}&encoding=utf8`);
          if (!res.ok) return;
          const { content } = await res.json();
          const text = content as string;
          const same = canon(editor, text) === canon(editor, editor.getMarkdown());
          if (same) { sourceRef.current = text; return; } // our own write, or a re-spelling — its disk text is the source now
          if (!shouldReloadFromDisk(diskSyncRef.current, text, same)) return;
          debouncedAutosave.cancel(); // a scheduled write of the now-stale doc must not fire
          setFromDisk(editor, text, true);
        } catch (e) { console.warn("richtext reload failed:", e); }
      }
    });

    // Seed + docId off whenReady (NOT the "synced" event): the provider may emit
    // "synced" before this effect subscribes (it's created eagerly in useState),
    // so catching the event races. whenReady resolves regardless of timing.
    (async () => {
      docIdRef.current = await sha1Base64(`${driveId}:${entry.path}`);
      await provider.whenReady;
      if (cancelled) return;
      // "Effectively empty": a freshly-bound editor auto-inserts one empty
      // paragraph (frag.length becomes 1), so check the rendered text too. If the
      // CRDT already carries content (loaded from Yjs store), getText() is
      // non-empty → don't re-seed (CRDT is authoritative).
      // The disk is read on every open: an empty editor seeds from it; a stored
      // fragment that disagrees with it is replaced unless the disk still holds
      // what this browser last loaded/wrote (then the difference is ours).
      if (!seededRef.current) {
        seededRef.current = true;
        try {
          const fileRes = await fetch(`/api/drives/${driveId}/fs/read?path=${encodeURIComponent(entry.path)}&encoding=utf8`);
          if (fileRes.ok && !cancelled) {
            const { content } = await fileRes.json();
            const disk = content as string;
            const effectivelyEmpty = editor.isEmpty || editor.getText().trim() === "";
            const docEqualsDisk = !effectivelyEmpty && canon(editor, disk) === canon(editor, editor.getMarkdown());
            const decision = decideOnOpen({
              docEmpty: effectivelyEmpty,
              docEqualsDisk,
              diskHash: hashText(disk),
              lastKnownDiskHash: loadKnownDiskHash(driveId, entry.path),
            });
            if (decision === "keep-doc") {
              // The disk is the baseline; a doc that differs carries our own unsaved edits.
              sourceRef.current = disk;
              diskSyncRef.current = { ...markLoaded(diskSyncRef.current, disk), dirty: !docEqualsDisk };
            } else if (disk.length > 0 || decision === "replace-from-disk") {
              setFromDisk(editor, disk, decision === "replace-from-disk");
            } else {
              sourceRef.current = "";
              diskSyncRef.current = markLoaded(diskSyncRef.current, "");
            }
          }
        } catch (e) { console.warn("richtext seed failed:", e); }
      }
      // Arm autosave only now — after seed (or the decision to skip it). Updates
      // before this point (the editor's empty-paragraph bind, the seed setContent)
      // must NOT schedule a write.
      readyToSaveRef.current = true;
      if (!cancelled) setLoading(false);
    })();

    // Local identity for collaboration carets.
    void (async () => {
      try {
        const me = await fetch("/api/whoami").then((r) => r.json());
        const id = me.name || (me.address ? `${me.address.slice(0, 6)}…${me.address.slice(-4)}` : "anon");
        provider.awareness.setLocalStateField("user", { name: id, color: colorForId(id) });
      } catch {}
    })();

    const refreshPresence = () => {
      const list: Presence[] = [];
      provider.awareness.getStates().forEach((state, clientId) => {
        const u = (state as { user?: { name?: string; color?: string } }).user;
        if (u?.name) list.push({ id: clientId, name: u.name, color: u.color || "#888" });
      });
      onPresenceRef.current(list);
    };
    provider.awareness.on("change", refreshPresence);
    refreshPresence();

    // Gate at SCHEDULE time, not just execution: the seed's setContent fires doc
    // updates synchronously before readyToSave flips, so they must not even
    // schedule a debounce (else it fires 5s later when readyToSave is true → a
    // no-edit rewrite of the file).
    const triggerSave = (_update: Uint8Array, origin: unknown) => {
      const kind = programmaticRef.current ? "programmatic" : provider.originOf(origin);
      diskSyncRef.current = noteUpdate(diskSyncRef.current, kind);
      if (kind !== "local" || !readyToSaveRef.current) return;
      void debouncedAutosave();
    };
    provider.doc.on("update", triggerSave);
    const onUnload = () => debouncedAutosave.flush();
    window.addEventListener("beforeunload", onUnload);

    return () => {
      cancelled = true;
      debouncedAutosave.flush();
      window.removeEventListener("beforeunload", onUnload);
      provider.doc.off("update", triggerSave);
      provider.awareness.off("change", refreshPresence);
      off();
    };
  }, [editor, provider, driveId, entry.path, debouncedAutosave]);

  // Destroy the provider when this file's editor unmounts.
  useEffect(() => () => provider.destroy(), [provider]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {canEdit && editor && <Toolbar editor={editor} />}
      <div className="flex-1 min-h-0 overflow-auto">
        {loading && (
          <div className="px-5 py-4 text-caption text-drive-muted">Loading document…</div>
        )}
        <EditorContent editor={editor} className="h-full" />
      </div>
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  // Subscribe to selection/transaction so active states re-render.
  const [, force] = useState(0);
  useEffect(() => {
    const h = () => force((n) => n + 1);
    editor.on("transaction", h);
    return () => { editor.off("transaction", h); };
  }, [editor]);

  const Btn = ({ on, disabled, onClick, title, children }: {
    on?: boolean; disabled?: boolean; onClick: () => void; title: string; children: React.ReactNode;
  }) => (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={on}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} // keep editor selection
      onClick={onClick}
      className={clsx(
        "flex h-8 w-8 items-center justify-center rounded-md transition-colors disabled:opacity-40",
        on ? "bg-drive-selected text-drive-accent" : "text-drive-text hover:bg-drive-hover",
      )}
    >
      {children}
    </button>
  );

  return (
    <div className="flex items-center gap-0.5 border-b border-drive-border px-2 py-1.5 flex-wrap">
      <Btn title="Bold" on={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}><Bold className="w-4 h-4" /></Btn>
      <Btn title="Italic" on={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic className="w-4 h-4" /></Btn>
      <Btn title="Inline code" on={editor.isActive("code")} onClick={() => editor.chain().focus().toggleCode().run()}><Code className="w-4 h-4" /></Btn>
      <span className="mx-1 h-5 w-px bg-drive-border" />
      <Btn title="Heading 1" on={editor.isActive("heading", { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}><Heading1 className="w-4 h-4" /></Btn>
      <Btn title="Heading 2" on={editor.isActive("heading", { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 className="w-4 h-4" /></Btn>
      <span className="mx-1 h-5 w-px bg-drive-border" />
      <Btn title="Bullet list" on={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}><List className="w-4 h-4" /></Btn>
      <Btn title="Ordered list" on={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered className="w-4 h-4" /></Btn>
      <Btn title="Quote" on={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote className="w-4 h-4" /></Btn>
      <span className="mx-1 h-5 w-px bg-drive-border" />
      <Btn title="Undo" onClick={() => editor.chain().focus().undo().run()}><Undo2 className="w-4 h-4" /></Btn>
      <Btn title="Redo" onClick={() => editor.chain().focus().redo().run()}><Redo2 className="w-4 h-4" /></Btn>
    </div>
  );
}
