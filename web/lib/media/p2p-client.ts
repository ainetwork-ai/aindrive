// The direct device → browser path, page side (P2P media spec M5). The server
// introduces this tab to the drive's agent (/api/media/rtc) and hands over the
// file's chunk hash list; chunks then come straight from the device over a WebRTC
// data channel, each verified before use. Any chunk that does not arrive in time,
// or fails verification, comes from the server instead: playback never depends on
// the direct path.
"use client";
import { encodeWant, Reassembler } from "@/shared/media/p2p";

const C = 1048576;
const OPEN_MS = 4000;
const CHUNK_MS = 4000;

type Manifest = { size: number; root: string; leaves: string[] };
/** `disabled`: skip the direct path (a kill switch; also how tests exercise the fallback). */
type Stats = { p2pBytes: number; serverBytes: number; sessions: number; disabled: boolean; closeAll(): void };

const stats: Stats = { p2pBytes: 0, serverBytes: 0, sessions: 0, disabled: false, closeAll: () => { for (const s of open.values()) void s.then((x) => x?.close()); open.clear(); } };
if (typeof window !== "undefined") (window as unknown as { __aindriveP2P: Stats }).__aindriveP2P = stats;

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const stun = () => process.env.NEXT_PUBLIC_AINDRIVE_STUN ?? "stun:stun.l.google.com:19302";

class P2PSession {
  private waiting = new Map<number, (c: Uint8Array | null) => void>();
  private reasm = new Reassembler();
  constructor(readonly manifest: Manifest, private readonly pc: RTCPeerConnection, private readonly ch: RTCDataChannel, private readonly ws: WebSocket) {
    ch.binaryType = "arraybuffer";
    ch.onmessage = (m) => {
      if (typeof m.data === "string") return;
      let got: { index: number; chunk: Uint8Array } | null = null;
      try { got = this.reasm.push(new Uint8Array(m.data as ArrayBuffer)); } catch { return; }
      if (got) this.waiting.get(got.index)?.(got.chunk);
    };
    ch.onclose = () => { for (const r of this.waiting.values()) r(null); this.waiting.clear(); };
  }

  get alive() { return this.ch.readyState === "open"; }

  /** Chunk `i` from the device, verified; null when it did not come in time or did not verify. */
  async chunk(i: number): Promise<Uint8Array | null> {
    if (!this.alive) return null;
    const got = await new Promise<Uint8Array | null>((resolve) => {
      const t = setTimeout(() => { this.waiting.delete(i); this.reasm.drop(i); resolve(null); }, CHUNK_MS);
      this.waiting.set(i, (c) => { clearTimeout(t); this.waiting.delete(i); resolve(c); });
      try { this.ch.send(encodeWant(i)); } catch { resolve(null); }
    });
    if (!got) return null;
    const digest = hex(await crypto.subtle.digest("SHA-256", got as unknown as ArrayBuffer));
    return digest === this.manifest.leaves[i] ? got : null;
  }

  close() { try { this.ch.close(); } catch {} try { this.pc.close(); } catch {} try { this.ws.close(); } catch {} }
}

async function openSession(driveId: string, path: string): Promise<P2PSession | null> {
  const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/api/media/rtc?drive=${encodeURIComponent(driveId)}&path=${encodeURIComponent(path)}`);
  const pc = new RTCPeerConnection({ iceServers: stun() ? [{ urls: stun() }] : [] });
  const fail = () => { try { pc.close(); } catch {} try { ws.close(); } catch {} return null; };
  const ready = await new Promise<Manifest | null>((resolve) => {
    const t = setTimeout(() => resolve(null), OPEN_MS);
    ws.onclose = () => { clearTimeout(t); resolve(null); };
    ws.onmessage = async (ev) => {
      let f: { t: string; manifest?: Manifest; data?: { type?: string; sdp?: string; candidate?: RTCIceCandidateInit } };
      try { f = JSON.parse(String(ev.data)); } catch { return; }
      if (f.t === "ready" && f.manifest) { clearTimeout(t); resolve(f.manifest); }
      else if (f.t === "signal" && f.data?.sdp) await pc.setRemoteDescription({ type: "answer", sdp: f.data.sdp }).catch(() => {});
      else if (f.t === "signal" && f.data?.candidate) await pc.addIceCandidate(f.data.candidate).catch(() => {});
    };
  });
  if (!ready) return fail();
  const ch = pc.createDataChannel("chunks");
  pc.onicecandidate = (e) => { if (e.candidate) ws.send(JSON.stringify({ t: "signal", data: { candidate: e.candidate.toJSON() } })); };
  await pc.setLocalDescription(await pc.createOffer());
  ws.send(JSON.stringify({ t: "signal", data: { type: "offer", sdp: pc.localDescription!.sdp } }));
  const opened = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), OPEN_MS);
    ch.onopen = () => { clearTimeout(t); resolve(true); };
  });
  if (!opened) return fail();
  stats.sessions++;
  return new P2PSession(ready, pc, ch, ws);
}

const open = new Map<string, Promise<P2PSession | null>>();
async function session(driveId: string, path: string): Promise<P2PSession | null> {
  if (stats.disabled) return null;
  const k = `${driveId}\0${path}`;
  const cur = open.get(k);
  if (cur) {
    const s = await cur;
    if (s?.alive) return s;
    open.delete(k); // the channel went away: try the direct path again
  }
  const p = openSession(driveId, path);
  open.set(k, p);
  void p.then((x) => { if (!x) open.delete(k); });
  return p;
}

/** Bytes [start, end] (inclusive, like a Range) of the file: device first, server for anything it does not bring. */
export async function p2pRange(driveId: string, path: string, start: number, endInclusive: number | null): Promise<{ size: number; stream: ReadableStream<Uint8Array> } | null> {
  const s = await session(driveId, path);
  if (!s) return null;
  const size = s.manifest.size;
  const end = Math.min(endInclusive ?? size - 1, size - 1);
  if (start > end) return null;
  let i = Math.floor(start / C);
  const last = Math.floor(end / C);
  const serverUrl = `/api/drives/${encodeURIComponent(driveId)}/fs/stream?path=${encodeURIComponent(path)}&via=server`;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i > last) { controller.close(); return; }
      const from = Math.max(start - i * C, 0);
      const to = Math.min(end - i * C, C - 1);
      let bytes: Uint8Array | null = s.alive ? await s.chunk(i) : null;
      if (bytes) { stats.p2pBytes += to - from + 1; bytes = bytes.subarray(from, to + 1); }
      else {
        const r = await fetch(serverUrl, { headers: { range: `bytes=${i * C + from}-${i * C + to}` } });
        if (!r.ok) { controller.error(new Error(`server ${r.status}`)); return; }
        bytes = new Uint8Array(await r.arrayBuffer());
        stats.serverBytes += bytes.length;
      }
      controller.enqueue(bytes);
      i++;
    },
  });
  return { size, stream };
}

/** The page's side of the service worker bridge: answer "p2p-range" requests. */
export function serveP2PForServiceWorker() {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
  navigator.serviceWorker.addEventListener("message", async (ev) => {
    const m = ev.data as { type?: string; driveId?: string; path?: string; start?: number; end?: number | null };
    const port = ev.ports[0];
    if (m?.type !== "p2p-range" || !port || !m.driveId || !m.path) return;
    try {
      const r = await p2pRange(m.driveId, m.path, m.start ?? 0, m.end ?? null);
      if (!r) { port.postMessage({ ok: false }); return; }
      port.postMessage({ ok: true, size: r.size, stream: r.stream }, [r.stream as unknown as Transferable]);
    } catch { port.postMessage({ ok: false }); }
  });
  navigator.serviceWorker.ready.then((reg) => reg.active?.postMessage({ type: "p2p-enable" })).catch(() => {});
}
