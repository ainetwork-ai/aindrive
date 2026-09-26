"use client";
import * as Y from "yjs";
import { Awareness, removeAwarenessStates, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import type { TraceEmitter } from "./trace-client";
import { hashSV } from "./trace-client";
import { willowClient } from "@/lib/willow/client";

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000];

type Listener = (event: string, payload?: unknown) => void;

/**
 * A small Y.js provider. Document content lives in the drive's Willow store
 * (lib/willow/client: signed entries, offline, synced through /api/willow/sync);
 * this provider keeps the ephemeral side on /api/agent/doc: awareness (cursors,
 * presence), the role, and "reload" when the file changed on disk.
 */
export class AindriveProvider {
  doc = new Y.Doc();
  awareness = new Awareness(this.doc);
  status: "connecting" | "connected" | "offline" = "connecting";
  role: string | null = null;

  private url: string;
  private ws: WebSocket | null = null;
  private attempt = 0;
  private listeners: Listener[] = [];
  private destroyed = false;
  private synced = false;
  private tracer: TraceEmitter | null = null;

  private unbindWillow: (() => void) | null = null;
  /** The content is bound to the drive's Willow store (signed in, IndexedDB available). */
  willowBound = false;
  /** The first sync with the server completed: only then may an empty doc be seeded from disk. */
  syncComplete = false;
  /** The drive's agent writes this document into its file itself: the browser does not save it. */
  agentMaterializes = false;
  private driveIdForAgent = "";

  /** Asks the server now (the agent may have just become ready); offline, the last answer for this drive. */
  async agentWrites(): Promise<boolean> {
    const memo = `aindrive-willow-agent-${this.driveIdForAgent}`;
    try {
      const j = await fetch(`/api/willow/agent?drive=${encodeURIComponent(this.driveIdForAgent)}`).then((r) => r.json());
      this.agentMaterializes = !!j.materializes;
      try { localStorage.setItem(memo, this.agentMaterializes ? "1" : "0"); } catch {}
    } catch {
      try { this.agentMaterializes = localStorage.getItem(memo) === "1"; } catch {}
    }
    return this.agentMaterializes;
  }
  /** Resolves once the local Willow store is loaded and the first sync with the server is done (or offline). */
  whenReady: Promise<void>;
  private resolveReady!: () => void;
  private idbReady: Promise<void> = Promise.resolve();

  constructor(driveId: string, path: string, canEdit = true) {
    this.driveIdForAgent = driveId;
    const proto = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = typeof window !== "undefined" ? window.location.host : "localhost:3737";
    this.url = `${proto}//${host}/api/agent/doc?drive=${encodeURIComponent(driveId)}&path=${encodeURIComponent(path)}`;
    this.whenReady = new Promise<void>((res) => { this.resolveReady = res; });
    if (typeof window !== "undefined" && typeof indexedDB !== "undefined") {
      this.idbReady = (async () => {
        try {
          const client = await willowClient(driveId);
          const unbind = await client.openDoc(path.split("/"), this.doc, !canEdit);
          if (this.destroyed) { unbind(); return; }
          this.unbindWillow = unbind;
          this.willowBound = true;
          void this.agentWrites();
          client.status.addEventListener("refused", (ev) => this.emit("refused", (ev as CustomEvent).detail));
          this.syncComplete = await client.initialSync;
        } catch (e) { console.warn("willow store unavailable:", e); }
      })();
      void this.idbReady.then(() => {
        if (this.destroyed || this.synced) return;
        this.synced = true;
        this.resolveReady();
        this.emit("synced");
        this.tracer?.("whenReady-resolved");
      });
    }
    this.doc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onLocalAwareness);
    this.connect();
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", this.shutdown);
    }
  }

  on(fn: Listener) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((l) => l !== fn); }; }
  private emit(ev: string, payload?: unknown) { for (const l of this.listeners) try { l(ev, payload); } catch {} }

  setTracer(tracer: TraceEmitter) { this.tracer = tracer; }

  private tag(origin: unknown): string {
    if (origin === this) return "remote";
    return "local";
  }

  private connect = () => {
    if (this.destroyed) return;
    this.status = "connecting"; this.emit("status", this.status);
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.attempt = 0;
      this.status = "connected"; this.emit("status", this.status);
      this.tracer?.("provider-connect");
      // Send our local awareness state if any
      const states = this.awareness.getStates();
      if (states.size > 0) {
        const u = encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
        this.send({ t: "aware", msg: bytesToB64(u) });
      }
    });
    ws.addEventListener("message", async (ev) => {
      let frame;
      try { frame = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer)); }
      catch { return; }
      if (!frame || typeof frame.t !== "string") return;
      if (frame.t === "sub-ok") {
        this.role = frame.role;
        this.emit("role", frame.role);
        this.tracer?.("provider-sub-ok", { extra: { role: frame.role, peers: frame.peers } });
        return;
      }
      // A Willow-bound doc's content comes only from signed entries: rewriting it
      // from disk here would sign and broadcast the disk text (review C1). Disk
      // edits reach it through the agent (Plan 3).
      if (frame.t === "reload") { if (!this.willowBound) this.emit("reload"); this.tracer?.("reload-event"); return; }
      if (frame.t === "aware") {
        applyAwarenessUpdate(this.awareness, b64ToBytes(frame.msg), this);
        return;
      }
    });
    ws.addEventListener("close", (ev) => {
      if (this.destroyed) return;
      this.ws = null;
      this.status = "offline"; this.emit("status", this.status);
      this.tracer?.("provider-disconnect", { code: ev.code });
      removeAwarenessStates(this.awareness, [...this.awareness.getStates().keys()].filter((k) => k !== this.doc.clientID), this);
      const wait = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)];
      this.attempt++;
      setTimeout(this.connect, wait);
    });
    ws.addEventListener("error", () => { try { ws.close(); } catch {} });
  };

  private send(frame: object) {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return;
    try { this.ws.send(JSON.stringify(frame)); } catch {}
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (!this.tracer) return;
    const originTag = this.tag(origin);
    const byteLen = update.byteLength;
    const ytext = this.doc.getText("content");
    const textLen = ytext.length;
    const sv = Y.encodeStateVector(this.doc);
    void hashSV(sv).then((svAfter) => {
      this.tracer?.("ydoc-update", { origin: originTag, byteLen, textLen, svAfter });
    });
  };

  private onLocalAwareness = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ) => {
    if (origin === this) return;
    const changed = added.concat(updated).concat(removed);
    if (changed.length === 0) return;
    const u = encodeAwarenessUpdate(this.awareness, changed);
    this.send({ t: "aware", msg: bytesToB64(u) });
  };

  shutdown = () => {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      removeAwarenessStates(this.awareness, [this.doc.clientID], "shutdown");
    } catch {}
    try { this.ws?.close(); } catch {}
  };

  /** True once shutdown/destroy ran. Lets callers (e.g. a StrictMode-double-
   *  mounted component holding the provider in a ref) detect a dead instance
   *  and recreate it. Read-only; does not change lifecycle behavior. */
  get isDestroyed() { return this.destroyed; }

  destroy() {
    this.shutdown();
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onLocalAwareness);
    this.awareness.destroy();
    if (this.unbindWillow) { try { this.unbindWillow(); } catch {} }
    this.doc.destroy();
  }
}

function bytesToB64(arr: Uint8Array): string {
  let s = ""; for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
