"use client";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { Awareness, removeAwarenessStates, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { TraceEmitter } from "./trace-client";
import { hashSV } from "./trace-client";

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000];

type Listener = (event: string, payload?: unknown) => void;

/** A small Y.js provider that talks to /api/agent/doc on our custom server. */
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

  private idb: IndexeddbPersistence | null = null;
  /** Resolves once both IndexedDB load AND first WS sync attempt have completed. */
  whenReady: Promise<void>;
  private resolveReady!: () => void;
  private idbReady: Promise<void> = Promise.resolve();

  constructor(driveId: string, path: string) {
    const proto = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = typeof window !== "undefined" ? window.location.host : "localhost:3737";
    this.url = `${proto}//${host}/api/agent/doc?drive=${encodeURIComponent(driveId)}&path=${encodeURIComponent(path)}`;
    this.whenReady = new Promise<void>((res) => { this.resolveReady = res; });
    // Local IndexedDB persistence — preserves edits across reloads + offline use
    if (typeof window !== "undefined" && typeof indexedDB !== "undefined") {
      try {
        this.idb = new IndexeddbPersistence(`aindrive:${driveId}:${path}`, this.doc);
        this.idbReady = this.idb.whenSynced.then(async () => {
          const ytext = this.doc.getText("content");
          const sv = Y.encodeStateVector(this.doc);
          const svHash = await hashSV(sv);
          this.tracer?.("idb-load", { textLen: ytext.length, svAfter: svHash });
        }).catch(() => undefined);
      } catch (e) { console.warn("y-indexeddb unavailable:", e); }
    }
    this.doc.on("update", this.onLocalUpdate);
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
    if (origin === this.idb) return "idb-restore";
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
      // Send our initial sync step 1 (state vector)
      const enc = encoding.createEncoder();
      syncProtocol.writeSyncStep1(enc, this.doc);
      this.send({ t: "sync", msg: bytesToB64(encoding.toUint8Array(enc)) });
      // Send our local awareness state if any
      const states = this.awareness.getStates();
      if (states.size > 0) {
        const u = encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
        this.send({ t: "aware", msg: bytesToB64(u) });
      }
      // Single-peer case: nobody else online to ack our step1, so after a grace
      // period we consider ourselves synced. The viewer must wait for BOTH
      // whenReady AND IndexedDB load before deciding whether to seed.
      setTimeout(async () => {
        if (this.synced) return;
        await this.idbReady;
        if (!this.synced && this.status === "connected") {
          this.synced = true;
          this.resolveReady();
          this.emit("synced");
          this.tracer?.("whenReady-resolved");
        }
      }, 800);
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
      if (frame.t === "reload") { this.emit("reload"); this.tracer?.("reload-event"); return; }
      if (frame.t === "sync") {
        const dec = decoding.createDecoder(b64ToBytes(frame.msg));
        const enc = encoding.createEncoder();
        const messageType = syncProtocol.readSyncMessage(dec, enc, this.doc, this);
        if (encoding.length(enc) > 0) this.send({ t: "sync", msg: bytesToB64(encoding.toUint8Array(enc)) });
        if (messageType === syncProtocol.messageYjsSyncStep2 && !this.synced) {
          await this.idbReady;
          this.synced = true;
          this.resolveReady();
          this.emit("synced");
          this.tracer?.("whenReady-resolved");
        }
        return;
      }
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

  private onLocalUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this) return; // do not echo updates that came from the wire
    const enc = encoding.createEncoder();
    syncProtocol.writeUpdate(enc, update);
    this.send({ t: "sync", msg: bytesToB64(encoding.toUint8Array(enc)) });
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

  destroy() {
    this.shutdown();
    this.doc.off("update", this.onLocalUpdate);
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onLocalAwareness);
    this.awareness.destroy();
    if (this.idb) { try { this.idb.destroy(); } catch {} }
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
