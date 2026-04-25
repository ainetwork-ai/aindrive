"use client";
import { useEffect, useRef, useState } from "react";
import { useDebouncedCallback } from "use-debounce";
import dynamic from "next/dynamic";
import { X, Save, Download, Loader2, Wifi, WifiOff } from "lucide-react";
import * as Y from "yjs";
import { MonacoBinding } from "y-monaco";
import { AindriveProvider } from "@/lib/yjs/aindrive-provider";
import { traceClient, SESSION_ID } from "@/lib/yjs/trace-client";
import type { TraceEmitter } from "@/lib/yjs/trace-client";
import type { DriveEntry } from "@/lib/protocol";

const MonacoEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.default), {
  ssr: false,
  loading: () => <div className="flex-1 flex items-center justify-center text-drive-muted"><Loader2 className="w-4 h-4 animate-spin" /></div>,
});

const TEXT_EXT = new Set([
  "txt", "md", "json", "js", "mjs", "ts", "tsx", "jsx", "html", "css",
  "py", "rs", "go", "yml", "yaml", "toml", "sh", "sql", "xml", "csv",
]);

export function Viewer({
  driveId, entry, canEdit, onClose, onSaved,
}: {
  driveId: string;
  entry: DriveEntry;
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [binaryDataUrl, setBinaryDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"connecting" | "connected" | "offline">("connecting");
  const [peers, setPeers] = useState(1);

  const isText = entry.mime.startsWith("text/") || entry.mime === "application/json" || TEXT_EXT.has(entry.ext);
  const isImage = entry.mime.startsWith("image/");
  const isPdf = entry.mime === "application/pdf";

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

        // Set up tracer now that we have the docId
        tracer = traceClient(docId, SESSION_ID);
        provider.setTracer(tracer);

        // Wait for full readiness (IndexedDB + WS sync) before deciding whether to seed
        await provider.whenReady;
        const ytext = provider.doc.getText("content");
        // Only seed if BOTH IndexedDB and the server-side Willow Store are empty.
        // Otherwise the existing CRDT state is authoritative — re-seeding would
        // duplicate content on every reload.
        if (ytext.length > 0) {
          tracer("disk-seed-skip");
        } else {
          const yjsRes = await fetch(`/api/drives/${driveId}/yjs?docId=${docId}&path=${encodeURIComponent(entry.path)}`);
          if (yjsRes.ok) {
            const { data } = await yjsRes.json();
            if (data) {
              try {
                const updateBytes = b64ToBytes(data);
                Y.applyUpdate(provider.doc, updateBytes, provider);
                tracer("yjs-pull-apply", { byteLen: updateBytes.byteLength });
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
                tracer("disk-seed-apply", { byteLen: new TextEncoder().encode(seedContent).byteLength });
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

  // Load binary preview (image / PDF)
  useEffect(() => {
    if (isText) return;
    let cancelled = false;
    setLoading(true); setBinaryDataUrl(null);
    (async () => {
      const res = await fetch(`/api/drives/${driveId}/fs/read?path=${encodeURIComponent(entry.path)}&encoding=base64`);
      if (cancelled) return;
      if (res.ok) {
        const data = await res.json();
        setBinaryDataUrl(`data:${entry.mime};base64,${data.content}`);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [driveId, entry.path, entry.mime, isText]);

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

  return (
    <aside className="fixed inset-0 z-30 w-full sm:static sm:inset-auto sm:z-auto sm:w-[520px] lg:w-[640px] border-l border-drive-border bg-white flex flex-col min-w-0">
      <header className="flex items-center justify-between gap-2 p-3 border-b border-drive-border">
        <div className="truncate font-medium flex items-center gap-2 min-w-0 flex-1">
          <span className="truncate">{entry.name}</span>
          {isText && (
            <span className={`text-xs flex items-center gap-1 shrink-0 ${status === "connected" ? "text-green-600" : status === "connecting" ? "text-amber-600" : "text-red-600"}`}>
              {status === "connected" ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
              {status === "offline" ? "offline" : status === "connecting" ? "connecting" : ""}
            </span>
          )}
          {isText && presence.length > 0 && (
            <div className="flex -space-x-1.5 shrink-0 ml-1">
              {presence.slice(0, 6).map((p) => (
                <span
                  key={p.id}
                  title={p.name}
                  className="w-6 h-6 rounded-full border-2 border-white text-[10px] font-semibold text-white flex items-center justify-center shadow-sm"
                  style={{ background: p.color }}
                >
                  {p.name.replace(/^0x/, "").slice(0, 2).toUpperCase()}
                </span>
              ))}
              {presence.length > 6 && (
                <span className="w-6 h-6 rounded-full border-2 border-white bg-drive-muted text-white text-[10px] font-semibold flex items-center justify-center">
                  +{presence.length - 6}
                </span>
              )}
            </div>
          )}
          {isText && !canEdit && (
            <span className="text-[10px] uppercase tracking-wide text-drive-muted bg-drive-sidebar rounded px-1.5 py-0.5 shrink-0">view-only</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {isText && canEdit && (
            <button onClick={save} disabled={saving} className="rounded px-2 py-1.5 text-sm hover:bg-drive-hover flex items-center gap-1">
              <Save className="w-4 h-4" /> {saving ? "Saving…" : "Save"}
            </button>
          )}
          {binaryDataUrl && (
            <a href={binaryDataUrl} download={entry.name} className="rounded px-2 py-1.5 text-sm hover:bg-drive-hover flex items-center gap-1">
              <Download className="w-4 h-4" /> Download
            </a>
          )}
          <button onClick={onClose} className="rounded p-1.5 hover:bg-drive-hover">
            <X className="w-4 h-4" />
          </button>
        </div>
      </header>
      <div className="flex-1 min-h-0 overflow-auto">
        {loading ? (
          <div className="h-full flex items-center justify-center text-drive-muted">
            <Loader2 className="w-4 h-4 animate-spin" />
          </div>
        ) : isImage && binaryDataUrl ? (
          <img src={binaryDataUrl} alt={entry.name} className="w-full h-auto" />
        ) : isPdf && binaryDataUrl ? (
          <iframe src={binaryDataUrl} className="w-full h-full" />
        ) : isText ? (
          <MonacoEditor
            height="100%"
            defaultLanguage={languageFor(entry)}
            onMount={onMonacoMount}
            options={{
              readOnly: !canEdit,
              minimap: { enabled: false },
              fontSize: 13,
              automaticLayout: true,
              wordWrap: "on",
            }}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-drive-muted text-sm p-6 text-center">
            Preview not available for this file type.
          </div>
        )}
      </div>
    </aside>
  );
}

function colorForId(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360}, 70%, 50%)`;
}

async function sha1Base64(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  const bytes = new Uint8Array(buf);
  let bin = ""; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 22);
}

function bytesToBase64(arr: Uint8Array): string {
  let s = ""; const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) s += String.fromCharCode(...arr.subarray(i, i + chunk));
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function languageFor(e: DriveEntry): string {
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", mjs: "javascript", jsx: "javascript",
    json: "json", md: "markdown", html: "html", css: "css",
    py: "python", rs: "rust", go: "go", yaml: "yaml", yml: "yaml",
    sh: "shell", sql: "sql", xml: "xml",
  };
  return map[e.ext] || "plaintext";
}
