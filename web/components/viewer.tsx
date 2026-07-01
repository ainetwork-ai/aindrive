"use client";
import { useEffect, useRef, useState } from "react";
import { useDebouncedCallback } from "use-debounce";
import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";
import * as Y from "yjs";
import { MonacoBinding } from "y-monaco";
import { AindriveProvider } from "@/lib/yjs/aindrive-provider";
import { traceClient, SESSION_ID } from "@/lib/yjs/trace-client";
import type { TraceEmitter } from "@/lib/yjs/trace-client";
import type { DriveEntry } from "@/lib/protocol";
import { TEXT_EXT, colorForId, sha1Base64, bytesToBase64, b64ToBytes, languageFor } from "./viewer-utils";
import { ViewerHeader } from "./viewer-parts";
import { fileIconForName } from "./file-icons";
import { RichTextEditor } from "./editors/rich-text-editor";
import { loader } from "@monaco-editor/react";
import clsx from "clsx";

// Monaco self-host: load the editor runtime from our own origin (/monaco/vs)
// instead of @monaco-editor/loader's default jsdelivr CDN, which the app CSP
// (script-src 'self', see middleware.ts) blocks. Assets are copied from
// node_modules/monaco-editor/min/vs by scripts/copy-monaco.mjs (predev/prebuild).
loader.config({ paths: { vs: "/monaco/vs" } });

const MonacoEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.default), {
  ssr: false,
  loading: () => <div className="flex-1 flex items-center justify-center text-drive-muted"><Loader2 className="w-4 h-4 animate-spin" /></div>,
});

export function Viewer({
  driveId, entry, canEdit, onClose, onSaved,
}: {
  driveId: string;
  entry: DriveEntry;
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"connecting" | "connected" | "offline">("connecting");
  const [peers, setPeers] = useState(1);
  // Touch devices: Monaco's IME + soft keyboard interplay is fragile, so we
  // surface the file as read-only and let the user use the Download button
  // to grab it for editing in a real editor.
  const [touchOnly, setTouchOnly] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(pointer: coarse) and (hover: none)");
    const sync = () => setTouchOnly(mq.matches);
    sync();
    mq.addEventListener?.("change", sync);
    return () => mq.removeEventListener?.("change", sync);
  }, []);

  // Markdown opens the rich-text (WYSIWYG) editor — a SEPARATE Y.Doc root
  // (getXmlFragment) from the Monaco/Y.Text path, so the two never collide. All
  // other text/code stays on Monaco. (See editor-framework-design.md.)
  const isRichText = entry.ext === "md" || entry.ext === "markdown" || entry.mime === "text/markdown";
  const isText = !isRichText && (entry.mime.startsWith("text/") || entry.mime === "application/json" || TEXT_EXT.has(entry.ext));
  const isImage = entry.mime.startsWith("image/");
  const isPdf = entry.mime === "application/pdf";
  const isVideo = entry.mime.startsWith("video/");
  const isAudio = entry.mime.startsWith("audio/");

  const providerRef = useRef<AindriveProvider | null>(null);
  const bindingRef = useRef<MonacoBinding | null>(null);
  const docIdRef = useRef<string>("");
  const [presence, setPresence] = useState<Array<{ id: number; name: string; color: string }>>([]);

  // Debounced autosave: trailing edge after 5s of no typing, max 15s between saves.
  const debouncedAutosave = useDebouncedCallback(
    async () => {
      if (!canEdit || !providerRef.current || !docIdRef.current) return;
      const provider = providerRef.current;
      const text = provider.doc.getText("content").toString();
      const update = Y.encodeStateAsUpdate(provider.doc);
      try {
        await Promise.all([
          fetch(`/api/drives/${driveId}/fs/write`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: entry.path, content: text, encoding: "utf8" }),
          }),
          fetch(`/api/drives/${driveId}/yjs`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ docId: docIdRef.current, path: entry.path, data: bytesToBase64(update) }),
          }),
        ]);
      } catch (e) { console.warn("autosave failed:", e); }
    },
    5000,
    { maxWait: 15000 },
  );

  // Set up Y.js provider for text files
  useEffect(() => {
    if (!isText) return;
    const provider = new AindriveProvider(driveId, entry.path);
    providerRef.current = provider;
    setLoading(true);
    let cancelled = false;
    let tracer: TraceEmitter | null = null;
    const off = provider.on(async (ev, payload) => {
      if (cancelled) return;
      if (ev === "status") setStatus(provider.status);
      if (ev === "role") {
        // sub-ok payload includes role; not needed beyond status
        void payload;
      }
      if (ev === "reload") {
        // External tool changed the file on disk — re-fetch and replace Y.Doc state.
        // CRITICAL: skip if disk content already matches our ytext, otherwise
        // our own autosave triggers fs.watch → reload → loop.
        try {
          const res = await fetch(`/api/drives/${driveId}/fs/read?path=${encodeURIComponent(entry.path)}&encoding=utf8`);
          if (res.ok) {
            const data = await res.json();
            const ytext = provider.doc.getText("content");
            const current = ytext.toString();
            const incoming = data.content as string;
            if (current === incoming) {
              // No-op: this reload was caused by our own autosave.
              return;
            }
            provider.doc.transact(() => {
              ytext.delete(0, ytext.length);
              ytext.insert(0, incoming);
            }, provider);
          }
        } catch (e) { console.warn("external reload failed:", e); }
      }
      if (ev === "synced") {
        // Compute docId for autosave + yjs persistence
        const docId = await sha1Base64(`${driveId}:${entry.path}`);
        docIdRef.current = docId;

        // Set up tracer only when explicitly debugging. The tracer hashes the
        // full Yjs state vector (SubtleCrypto SHA-1) on every doc update and
        // POSTs batches to /api/dev/trace — measurable typing lag on larger
        // docs. Leaving the provider's tracer null makes onDocUpdate's hash +
        // POST a no-op for normal editing. Opt in via NEXT_PUBLIC_AINDRIVE_TRACE
        // or a localStorage flag. (Server-side WS/RPC traces are unaffected.)
        const traceOn =
          process.env.NEXT_PUBLIC_AINDRIVE_TRACE === "on" ||
          (typeof window !== "undefined" && window.localStorage.getItem("aindrive_trace") === "on");
        if (traceOn) {
          tracer = traceClient(docId, SESSION_ID);
          provider.setTracer(tracer);
        }

        // Wait for full readiness (IndexedDB + WS sync) before deciding whether to seed
        await provider.whenReady;
        const ytext = provider.doc.getText("content");
        // Only seed if BOTH IndexedDB and the server-side Willow Store are empty.
        // Otherwise the existing CRDT state is authoritative — re-seeding would
        // duplicate content on every reload.
        if (ytext.length > 0) {
          tracer?.("disk-seed-skip");
        } else {
          const yjsRes = await fetch(`/api/drives/${driveId}/yjs?docId=${docId}&path=${encodeURIComponent(entry.path)}`);
          if (yjsRes.ok) {
            const { data } = await yjsRes.json();
            if (data) {
              try {
                const updateBytes = b64ToBytes(data);
                Y.applyUpdate(provider.doc, updateBytes, provider);
                tracer?.("yjs-pull-apply", { byteLen: updateBytes.byteLength });
              }
              catch (e) { console.warn("y-apply-update failed:", e); }
            }
          }
          if (provider.doc.getText("content").length === 0) {
            const fileRes = await fetch(`/api/drives/${driveId}/fs/read?path=${encodeURIComponent(entry.path)}&encoding=utf8`);
            if (fileRes.ok) {
              const fdata = await fileRes.json();
              if (provider.doc.getText("content").length === 0) {
                const seedContent = fdata.content as string;
                provider.doc.transact(() => ytext.insert(0, seedContent), provider);
                tracer?.("disk-seed-apply", { byteLen: new TextEncoder().encode(seedContent).byteLength });
              }
            }
          }
        }
        setLoading(false);
      }
    });
    // Set local identity (name + color) so other peers know who is editing.
    void (async () => {
      try {
        const me = await fetch("/api/whoami").then((r) => r.json());
        const id = me.name || (me.address ? `${me.address.slice(0, 6)}…${me.address.slice(-4)}` : `anon-${Math.random().toString(36).slice(2, 6)}`);
        const color = colorForId(id);
        provider.awareness.setLocalStateField("user", { name: id, color });
      } catch {}
    })();
    const refreshPresence = () => {
      const list: Array<{ id: number; name: string; color: string }> = [];
      provider.awareness.getStates().forEach((state, clientId) => {
        const u = (state as { user?: { name?: string; color?: string } }).user;
        if (u?.name) list.push({ id: clientId, name: u.name, color: u.color || "#888" });
      });
      setPresence(list);
      setPeers(provider.awareness.getStates().size);
    };
    provider.awareness.on("change", refreshPresence);
    refreshPresence();

    // Autosave: trailing-edge 5s debounce with maxWait 15s (via useDebouncedCallback above).
    const triggerSave = () => {
      tracer?.("autosave-trigger", { reason: "tick" });
      void debouncedAutosave();
    };
    provider.doc.on("update", triggerSave);
    // beforeunload: flush any pending debounce immediately.
    const onUnload = () => {
      debouncedAutosave.flush();
    };
    window.addEventListener("beforeunload", onUnload);

    return () => {
      cancelled = true;
      debouncedAutosave.flush();
      window.removeEventListener("beforeunload", onUnload);
      provider.doc.off("update", triggerSave);
      off();
      bindingRef.current?.destroy(); bindingRef.current = null;
      provider.destroy(); providerRef.current = null;
    };
  }, [driveId, entry.path, isText, canEdit, debouncedAutosave]);

  // Binary previews stream straight from fs/stream (Range-aware, no size
  // ceiling) — the old base64 data-URL path buffered the whole file AND broke
  // on anything past the agent's 8 MiB read cap (videos played as corrupt).
  // The &v= param re-keys the URL when the file changes.
  const streamUrl = `/api/drives/${driveId}/fs/stream?path=${encodeURIComponent(entry.path)}&v=${entry.mtimeMs}`;
  const downloadUrl = `/api/drives/${driveId}/fs/download?path=${encodeURIComponent(entry.path)}`;
  useEffect(() => {
    if (isText || isRichText) return;
    // Nothing to prefetch — the media elements load from streamUrl themselves.
    setLoading(false);
  }, [isText, isRichText]);

  function onMonacoMount(editor: unknown, monaco: unknown) {
    if (!isText || !providerRef.current) return;
    const provider = providerRef.current;
    const ytext = provider.doc.getText("content");
    // y-monaco needs the editor's underlying TextModel + Awareness
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ed = editor as any;
    const model = ed.getModel();
    bindingRef.current = new MonacoBinding(ytext, model, new Set([ed]), provider.awareness);
    void monaco;
  }

  async function save() {
    if (!canEdit || !providerRef.current) return;
    setSaving(true);
    const text = providerRef.current.doc.getText("content").toString();
    const res = await fetch(`/api/drives/${driveId}/fs/write`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: entry.path, content: text, encoding: "utf8" }),
    });
    setSaving(false);
    if (!res.ok) alert((await res.json()).error);
    else onSaved();
  }

  // Download via a short-lived signed URL instead of a bare <a href> to
  // fs/download. In-app mobile webviews (Base App) hand an attachment
  // navigation to a separate OS downloader that drops the session cookie, so
  // the cookie-gated endpoint 403s ("forbidden") even though this same viewer
  // streams the file fine. This fetch carries the cookie, mints a token, and
  // the token authorizes the cookieless download. See lib/download-token.ts.
  async function onDownload() {
    try {
      const res = await fetch(`/api/drives/${driveId}/fs/download-token?path=${encodeURIComponent(entry.path)}`);
      if (!res.ok) {
        const msg = await res.json().then((j) => j.error).catch(() => null);
        alert(msg || "Download failed");
        return;
      }
      const { url } = await res.json();
      window.location.assign(url);
    } catch {
      alert("Download failed");
    }
  }

  return (
    <aside className="fixed inset-0 z-30 w-full sm:static sm:inset-auto sm:z-auto sm:w-[520px] lg:w-[640px] border-l border-drive-border bg-white flex flex-col min-w-0">
      <ViewerHeader
        name={entry.name}
        collaborative={isText || isRichText}
        showSave={isText}
        status={status}
        presence={presence}
        canEdit={canEdit}
        saving={saving}
        onSave={save}
        downloadUrl={isText || isRichText ? null : downloadUrl}
        onDownload={onDownload}
        onClose={onClose}
      />
      {isRichText ? (
        // Rich-text manages its own loading + scroll; keep it outside the
        // binary/text loading gate (neither viewer effect fires for .md).
        <div className="flex-1 min-h-0">
          <RichTextEditor
            key={entry.path}
            driveId={driveId}
            entry={entry}
            canEdit={canEdit && !touchOnly}
            onStatus={setStatus}
            onPresence={(p) => { setPresence(p); setPeers(Math.max(1, p.length)); }}
          />
        </div>
      ) : (
      <div className="flex-1 min-h-0 overflow-auto">
        {loading ? (
          <div className="h-full flex items-center justify-center text-drive-muted">
            <Loader2 className="w-4 h-4 animate-spin" />
          </div>
        ) : isImage ? (
          <ImageViewer src={streamUrl} name={entry.name} />
        ) : isVideo ? (
          <div className="h-full flex items-center justify-center bg-black p-2">
            {/* preload=metadata: grab duration/dimensions only; bytes flow on
                play/seek via Range requests. */}
            <video src={streamUrl} controls preload="metadata" className="max-w-full max-h-full rounded-md" />
          </div>
        ) : isAudio ? (
          <AudioCard src={streamUrl} name={entry.name} />
        ) : isPdf ? (
          <iframe src={streamUrl} title={entry.name} className="w-full h-full" />
        ) : isText ? (
          <MonacoEditor
            height="100%"
            defaultLanguage={languageFor(entry)}
            onMount={onMonacoMount}
            options={{
              readOnly: !canEdit || touchOnly,
              minimap: { enabled: false },
              fontSize: 13,
              automaticLayout: true,
              wordWrap: "on",
            }}
          />
        ) : (
          <UnsupportedPreview entry={entry} canDownload={true} />
        )}
      </div>
      )}
    </aside>
  );
}

/**
 * Image preview with fit-to-width default and click-to-toggle 1:1 zoom. A
 * checkerboard backdrop makes transparent PNGs legible. Cursor signals the
 * zoom affordance.
 */
function ImageViewer({ src, name }: { src: string; name: string }) {
  const [zoomed, setZoomed] = useState(false);
  return (
    <div
      className={clsx(
        "min-h-full flex items-center justify-center p-4",
        zoomed ? "overflow-auto cursor-zoom-out" : "cursor-zoom-in",
      )}
      style={{
        // Subtle checkerboard so transparent images read against white panel.
        backgroundImage:
          "linear-gradient(45deg,#f1f3f4 25%,transparent 25%),linear-gradient(-45deg,#f1f3f4 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#f1f3f4 75%),linear-gradient(-45deg,transparent 75%,#f1f3f4 75%)",
        backgroundSize: "16px 16px",
        backgroundPosition: "0 0,0 8px,8px -8px,-8px 0",
      }}
      onClick={() => setZoomed((v) => !v)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={name}
        className={clsx("rounded-md shadow-e1", zoomed ? "max-w-none" : "max-w-full h-auto")}
      />
    </div>
  );
}

/** Audio player card — type icon + filename over a full-width <audio> control. */
function AudioCard({ src, name }: { src: string; name: string }) {
  const { Icon, className: tone } = fileIconForName(name);
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 p-6">
      <Icon className={clsx("w-16 h-16", tone)} />
      <div className="text-body text-drive-text text-center max-w-xs truncate" title={name}>{name}</div>
      <audio src={src} controls className="w-full max-w-sm" />
    </div>
  );
}

/** Fallback for types with no inline preview — type icon + download hint. */
function UnsupportedPreview({ entry, canDownload }: { entry: DriveEntry; canDownload: boolean }) {
  const { Icon, className: tone } = fileIconForName(entry.name);
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center">
      <Icon className={clsx("w-16 h-16", tone)} />
      <div className="text-body text-drive-text max-w-xs truncate" title={entry.name}>{entry.name}</div>
      <p className="text-caption text-drive-muted">
        {canDownload ? "No inline preview — use Download to open it locally." : "No preview available for this file type."}
      </p>
    </div>
  );
}
