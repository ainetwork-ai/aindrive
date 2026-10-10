"use client";
import { useEffect, useRef, useState } from "react";
import { useDebouncedCallback } from "use-debounce";
import dynamic from "next/dynamic";
import { Loader2, Play, Square } from "lucide-react";
import * as Y from "yjs";
import { MonacoBinding } from "y-monaco";
import { AindriveProvider } from "@/lib/yjs/aindrive-provider";
import { traceClient, SESSION_ID } from "@/lib/yjs/trace-client";
import type { TraceEmitter } from "@/lib/yjs/trace-client";
import type { DriveEntry } from "@/lib/protocol";
import { TEXT_EXT, colorForId, sha1Base64, bytesToBase64, b64ToBytes, languageFor } from "./viewer-utils";
import { decideOnOpen, hashText, loadKnownDiskHash, markLoaded, shouldReloadFromDisk } from "@/lib/doc-disk-sync";
import { openSession, sessionLoaded, sessionUpdate, writeVerdict, type EditorSession } from "@/lib/editor-session";
import { ViewerHeader } from "./viewer-parts";
import { isTextByName, looksLikeText, needsSniff, textLanguageByName, SNIFF_BYTES } from "@/lib/text-kind";
import { RUN_IDLE, runLanguageFor } from "@/lib/git-panel";
import { inputsToEnv, missingRequired } from "@/lib/run-inputs";
import { InputField, useRunInputs, type GitPanelMeta } from "./git-panel";
import { RunDot, RunOutput, useRunner } from "./run-output";
import { toast } from "sonner";
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
  driveId, entry, canEdit, onClose, onSaved, gitRepo = null, repoMeta = null, ainizeProjectUrl = null, links = null,
}: {
  driveId: string;
  entry: DriveEntry;
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** the repo folder this file is in (null outside a repo) — ▶ Run needs it (the run route takes repo + entry) */
  gitRepo?: string | null;
  /** that repo's git-meta: the manifest's `entry` and `inputs` (the fields Run asks for) */
  repoMeta?: Pick<GitPanelMeta, "manifest" | "entry"> | null;
  ainizeProjectUrl?: string | null;
  /** Raw · History links (repo pages) */
  links?: { raw: string; history: string } | null;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Unsaved edits: what the editor holds vs. the last content written to disk (seed, autosave, Save).
  // Run executes the file ON DISK (the route reads the working tree through the agent at click time),
  // so while dirty the primary action is "Save & Run" — never a run of stale bytes.
  const [dirty, setDirty] = useState(false);
  const savedTextRef = useRef<string | null>(null);
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
  const isImage = entry.mime.startsWith("image/");
  const isPdf = entry.mime === "application/pdf";
  const isVideo = entry.mime.startsWith("video/");
  const isAudio = entry.mime.startsWith("audio/");
  // Text by name (extension, or `Dockerfile`/`Makefile`/`.gitignore`/… — lib/text-kind.ts), else — for a
  // name that says nothing — by content: the first 8 KiB without a NUL byte, read with one Range request.
  const textByName = !isRichText && (entry.mime.startsWith("text/") || entry.mime === "application/json" || TEXT_EXT.has(entry.ext) || isTextByName(entry.path));
  const sniff = !isRichText && !textByName && !isImage && !isPdf && !isVideo && !isAudio && needsSniff(entry.path, entry.mime);
  const [sniffed, setSniffed] = useState<boolean | null>(null);
  useEffect(() => {
    setSniffed(null);
    if (!sniff) return;
    const ctrl = new AbortController();
    fetch(`/api/drives/${driveId}/fs/stream?path=${encodeURIComponent(entry.path)}&v=${entry.mtimeMs}`, { headers: { Range: `bytes=0-${SNIFF_BYTES - 1}` }, signal: ctrl.signal })
      .then(async (r) => (r.ok ? looksLikeText(new Uint8Array(await r.arrayBuffer())) : false))
      .then((t) => { if (!ctrl.signal.aborted) setSniffed(t); })
      .catch(() => { if (!ctrl.signal.aborted) setSniffed(false); });
    return () => ctrl.abort();
  }, [driveId, entry.path, entry.mtimeMs, sniff]);
  const isText = textByName || sniffed === true;
  const sniffing = sniff && sniffed === null;

  const providerRef = useRef<AindriveProvider | null>(null);
  const bindingRef = useRef<MonacoBinding | null>(null);
  const docIdRef = useRef<string>("");
  // The open file's session (lib/editor-session.ts): path, generation, provider
  // and disk-sync state in ONE object created when the file opens. This
  // component is not keyed by path — switching files reuses it, its refs and
  // the debounced autosave — so nothing that writes may read `entry.path` or
  // `providerRef` from the render: a flush during the switch would pair the new
  // path with the old doc (that wrote ainize.json into art_search.py). Every
  // write names the session that produced the text and is refused unless that
  // session is still the active one.
  const sessionRef = useRef<(EditorSession & { provider: AindriveProvider }) | null>(null);
  const [presence, setPresence] = useState<Array<{ id: number; name: string; color: string }>>([]);

  type Session = EditorSession & { provider: AindriveProvider };

  // Replace the whole Y.Text with disk content, origin = provider so the
  // update is tagged "remote" (not a local edit → does not arm autosave).
  function replaceFromDisk(s: Session, text: string, replaced: boolean) {
    const ytext = s.provider.doc.getText("content");
    s.provider.doc.transact(() => {
      if (ytext.length > 0) ytext.delete(0, ytext.length);
      if (text.length > 0) ytext.insert(0, text);
    }, s.provider);
    sessionLoaded(s, text, { replaced });
  }

  /** Write `text` for session `s` — only if `s` is still the open file and the
   *  text is its own (never another file's). Returns null when refused. */
  async function writeToDisk(s: Session, text: string, source: "autosave" | "user-save"): Promise<Response | null> {
    const v = writeVerdict(s, sessionRef.current, text, { requireDirty: source === "autosave" });
    if (!v.ok) {
      if (v.reason === "stale-session" || v.reason === "cross-file") console.warn(`[viewer] write refused (${v.reason}): ${v.detail ?? ""}`);
      return null;
    }
    const res = await fetch(`/api/drives/${s.driveId}/fs/write`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: s.path, content: text, encoding: "utf8", source }),
    });
    if (res.ok && sessionRef.current === s) sessionLoaded(s, text);
    return res;
  }

  // Debounced autosave: trailing edge after 5s of no typing, max 15s between saves.
  // Reads only the active session — never `entry.path` or `providerRef`.
  const debouncedAutosave = useDebouncedCallback(
    async () => {
      const s = sessionRef.current;
      if (!canEdit || !s || !docIdRef.current) return;
      const text = s.provider.doc.getText("content").toString();
      const update = Y.encodeStateAsUpdate(s.provider.doc);
      try {
        const w = await writeToDisk(s, text, "autosave");
        if (w === null) return; // refused: not dirty / unchanged / stale / cross-file
        if (w.ok && sessionRef.current === s) markSaved(text);
        await fetch(`/api/drives/${s.driveId}/yjs`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: s.path, data: bytesToBase64(update) }),
        });
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
    const session: Session = Object.assign(openSession(driveId, entry.path), { provider });
    sessionRef.current = session;
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
        // External tool changed the file on disk — re-fetch and replace Y.Doc
        // state. The disk is authoritative: a pending local edit is dropped in
        // favor of what the external writer put there (it already won on disk).
        // Skipped when the disk already matches the doc (our own autosave
        // echoing through fs.watch → reload → loop).
        try {
          const res = await fetch(`/api/drives/${driveId}/fs/read?path=${encodeURIComponent(entry.path)}&encoding=utf8`);
          if (res.ok) {
            const data = await res.json();
            if (cancelled || sessionRef.current !== session) return; // the file changed under the await
            const current = provider.doc.getText("content").toString();
            const incoming = data.content as string;
            if (!shouldReloadFromDisk(session.sync, incoming, current === incoming)) return;
            debouncedAutosave.cancel(); // a scheduled write of the now-stale doc must not fire
            replaceFromDisk(session, incoming, true);
            tracer?.("disk-reload-apply", { byteLen: new TextEncoder().encode(incoming).byteLength });
          }
        } catch (e) { console.warn("external reload failed:", e); }
      }
      if (ev === "synced") {
        // docId keys the client trace (the server names the stored doc from the
        // path itself); setting it also marks the doc synced for autosave.
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
        if (ytext.length === 0) {
          // Nothing local: try the server-side Willow Store before the file.
          const yjsRes = await fetch(`/api/drives/${driveId}/yjs?path=${encodeURIComponent(entry.path)}`);
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
        }
        // The file on disk is consulted on EVERY open. A stored CRDT (IndexedDB
        // or Willow) is kept only when it agrees with the disk, or when the disk
        // still holds what this browser last loaded/wrote (so the difference is
        // our own unsaved edit). A disk changed by anything else — a git push
        // into the working tree, another tool — wins and replaces the doc.
        // Before this check the stored CRDT was treated as authoritative and
        // the stale text was autosaved over the new file (incident 2026-10-10).
        const fileRes = await fetch(`/api/drives/${driveId}/fs/read?path=${encodeURIComponent(entry.path)}&encoding=utf8`);
        if (fileRes.ok && !cancelled && sessionRef.current === session) {
          const fdata = await fileRes.json();
          if (cancelled || sessionRef.current !== session) return;
          const disk = fdata.content as string;
          const current = provider.doc.getText("content").toString();
          const decision = decideOnOpen({
            docEmpty: current.length === 0,
            docEqualsDisk: current === disk,
            diskHash: hashText(disk),
            lastKnownDiskHash: loadKnownDiskHash(driveId, entry.path),
          });
          if (decision === "keep-doc") {
            // The disk is the baseline; with unsaved offline edits the doc is dirty.
            sessionLoaded(session, disk);
            session.sync = { ...markLoaded(session.sync, disk), dirty: current !== disk };
            tracer?.("disk-seed-skip");
          } else {
            replaceFromDisk(session, disk, decision === "replace-from-disk");
            tracer?.(decision === "seed-from-disk" ? "disk-seed-apply" : "disk-reload-apply",
              { byteLen: new TextEncoder().encode(disk).byteLength });
          }
        }
        // Whatever the editor holds now is what the next autosave/Save will write; until then it is
        // "saved" relative to the disk only if it matches it — the disk read says.
        if (savedTextRef.current === null) {
          try {
            const r = await fetch(`/api/drives/${driveId}/fs/read?path=${encodeURIComponent(entry.path)}&encoding=utf8`);
            savedTextRef.current = r.ok ? String((await r.json()).content ?? "") : provider.doc.getText("content").toString();
          } catch { savedTextRef.current = provider.doc.getText("content").toString(); }
          setDirty(provider.doc.getText("content").toString() !== savedTextRef.current);
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
    // Armed by LOCAL updates only: the IndexedDB restore, the server sync and
    // our own disk reload/seed (origin = provider) are not edits, and before
    // this gate each of them scheduled a write of whatever the doc held.
    const triggerSave = (_update: Uint8Array, origin: unknown) => {
      const kind = provider.originOf(origin);
      sessionUpdate(session, kind);
      if (kind !== "local") return;
      tracer?.("autosave-trigger", { reason: "tick" });
      if (savedTextRef.current !== null) setDirty(provider.doc.getText("content").toString() !== savedTextRef.current);
      void debouncedAutosave();
    };
    provider.doc.on("update", triggerSave);
    // beforeunload: flush any pending debounce immediately.
    const onUnload = () => {
      debouncedAutosave.flush();
    };
    window.addEventListener("beforeunload", onUnload);

    savedTextRef.current = null; setDirty(false);
    return () => {
      cancelled = true;
      // Flush while THIS session is still active: a pending edit of this file is
      // written to this file's path. (The flush runs the latest autosave closure,
      // which reads sessionRef — never the render's entry.path.) Then retire the
      // session so any later callback for it is refused as stale.
      debouncedAutosave.flush();
      if (sessionRef.current === session) sessionRef.current = null;
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
    if (isText || isRichText || sniffing) return;
    // Nothing to prefetch — the media elements load from streamUrl themselves.
    setLoading(false);
  }, [isText, isRichText, sniffing]);

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

  // The text now on disk (as far as this editor knows); the editor is clean when it matches.
  function markSaved(text: string) {
    savedTextRef.current = text;
    const cur = sessionRef.current?.provider.doc.getText("content").toString();
    setDirty(cur !== undefined && cur !== text);
  }

  async function save(): Promise<boolean> {
    const s = sessionRef.current;
    if (!canEdit || !s) return false;
    setSaving(true);
    const text = s.provider.doc.getText("content").toString();
    const res = await writeToDisk(s, text, "user-save");
    setSaving(false);
    if (res === null) { alert("Save refused: this content belongs to another file or the file changed. Reload and try again."); return false; }
    if (!res.ok) { alert((await res.json()).error); return false; }
    markSaved(text);
    onSaved();
    return true;
  }

  // ▶ Run — next to Save, for a runnable file of a repo (`.py`/`.js`/`.mjs`, or the manifest's entry).
  // The same runner/inputs as the git panel's Run row (components/git-panel.tsx): the inputs open
  // inline under the header, the output streams under the editor. Dirty editor → "Save & Run": the
  // run route reads the working tree through the agent, so the save lands first, then the run.
  const manifest = repoMeta?.manifest ?? null;
  const manifestEntryPath = manifest?.entry && gitRepo !== null ? (gitRepo ? `${gitRepo}/${manifest.entry}` : manifest.entry) : null;
  const runnable = gitRepo !== null && !entry.locked && (runLanguageFor(entry.path) !== null || entry.path === manifestEntryPath);
  const runner = useRunner(driveId, gitRepo);
  const inputs = manifest?.inputs ?? [];
  const { values, setValue } = useRunInputs(driveId, gitRepo ?? "", inputs);
  const [runBarOpen, setRunBarOpen] = useState(false);
  const run = runner.runs[entry.path] ?? RUN_IDLE;
  const running = run.status === "running";
  async function startRun() {
    if (!runnable) return;
    const missing = missingRequired(inputs, values);
    if (missing.length) { setRunBarOpen(true); toast.error(`Fill in ${missing.join(", ")}`); return; }
    if (dirty && canEdit && isText) { if (!(await save())) return; }
    runner.run(entry.path, inputsToEnv(inputs, values));
  }
  const onRunClick = () => {
    if (running) { runner.stop(entry.path); return; }
    // With inputs, the first click opens the fields; the bar's own ▶ Run (or a second click) runs.
    if (inputs.length > 0 && !runBarOpen) { setRunBarOpen(true); return; }
    void startRun();
  };
  const runLabel = running ? "Stop" : dirty && canEdit && isText ? "Save & Run" : "Run";
  const runButton = runnable ? (
    <button
      type="button"
      onClick={onRunClick}
      disabled={saving || (loading && isText)}
      aria-label={running ? "Stop run" : dirty && canEdit && isText ? "Save and run file" : "Run file"}
      title={dirty && canEdit && isText && !running ? "Unsaved edits are saved first, then the file runs" : undefined}
      data-testid="viewer-run"
      data-dirty={dirty || undefined}
      className={clsx("rounded px-2 py-1.5 text-sm hover:bg-drive-hover flex items-center gap-1 disabled:opacity-50", running ? "text-red-600" : dirty && canEdit && isText ? "text-drive-accent font-medium" : "")}
    >
      {run.status !== "idle" && <RunDot status={run.status} />}
      {running ? <Square className="w-4 h-4" aria-hidden="true" /> : <Play className="w-4 h-4" aria-hidden="true" />} {runLabel}
    </button>
  ) : null;

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
        downloadUrl={isText || isRichText || sniffing ? null : downloadUrl}
        onDownload={onDownload}
        onClose={onClose}
        actions={runButton}
        links={links ? [{ label: "Raw", href: links.raw }, { label: "History", href: links.history }] : null}
      />
      {runnable && runBarOpen && (
        <div className="border-b border-drive-border bg-drive-panel px-3 py-2" data-testid="viewer-run-inputs">
          {inputs.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {inputs.map((i) => <InputField key={i.name} input={i} value={values[i.name] ?? ""} onChange={(v) => setValue(i.name, v)} />)}
            </div>
          )}
          <div className="mt-2 flex items-center gap-2">
            <button type="button" onClick={() => void startRun()} disabled={running || saving} className="rounded bg-drive-accent text-white px-3 py-1 text-sm hover:bg-drive-accentHover disabled:opacity-50 inline-flex items-center gap-1">
              <Play className="w-3.5 h-3.5" aria-hidden="true" /> {dirty && canEdit && isText ? "Save & Run" : "Run"}
            </button>
            <button type="button" onClick={() => setRunBarOpen(false)} className="text-sm text-drive-muted hover:text-drive-text">Hide</button>
          </div>
        </div>
      )}
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
        {loading || sniffing ? (
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
            key={entry.path}
            path={entry.path}
            height="100%"
            defaultLanguage={textLanguageByName(entry.path) ?? languageFor(entry)}
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
      {runnable && run.status !== "idle" && (
        <div className="border-t border-drive-border p-2 max-h-[45%] overflow-auto" data-testid="viewer-run-output">
          <RunOutput state={run} entryName={entry.name} openUrl={ainizeProjectUrl} />
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
