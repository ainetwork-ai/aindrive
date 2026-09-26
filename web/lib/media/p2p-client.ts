// The direct device → browser path, page side (P2P media spec M5). The server
// introduces this tab to the drive's agent (/api/media/rtc) and hands over the
// file's chunk hash list; chunks then come straight from the device over a WebRTC
// data channel. Every chunk, from the device or from the server, is verified whole
// against that list before a byte of it is used: a file that changed underneath
// ends the stream with an error rather than stitching two versions together.
// Playback never depends on the direct path: a chunk the device does not bring in
// time comes from the server, and a drive whose direct path failed is not retried
// for a while (no repeated waits).
import { encodeWant, Reassembler } from "@/shared/media/p2p";

const C = 1048576;
const OPEN_MS = 4000;
const CHUNK_MS = 4000;
const FAILED_RETRY_MS = 5 * 60_000;

export type Manifest = { size: number; root: string; leaves: string[] };
type Chan = { readyState: string; binaryType: string; send(m: string): void; close(): void; onmessage: ((m: { data: unknown }) => void) | null; onclose: (() => void) | null };

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const sha256hex = async (b: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", b as unknown as ArrayBuffer));

export class P2PSession {
  // one pending request per chunk, shared by every reader of it (review I3)
  private readonly pending = new Map<number, Promise<Uint8Array | null>>();
  private readonly resolvers = new Map<number, (c: Uint8Array | null) => void>();
  // pieces are accepted only for chunks asked for, and a few at a time (review M4)
  private readonly reasm = new Reassembler({ accept: (i) => this.resolvers.has(i), maxOpen: 4 });

  constructor(readonly manifest: Manifest, private readonly pc: { close(): void }, private readonly ch: Chan, private readonly ws: { close(): void }) {
    ch.binaryType = "arraybuffer";
    ch.onmessage = (m) => {
      if (typeof m.data === "string") return;
      let got: { index: number; chunk: Uint8Array } | null = null;
      try { got = this.reasm.push(new Uint8Array(m.data as ArrayBuffer)); } catch { return; }
      if (got) this.resolvers.get(got.index)?.(got.chunk);
    };
    ch.onclose = () => { for (const r of this.resolvers.values()) r(null); };
  }

  get alive() { return this.ch.readyState === "open"; }

  /** Chunk `i` from the device, verified; null when it did not come in time or did not verify. */
  chunk(i: number): Promise<Uint8Array | null> {
    const hit = this.pending.get(i);
    if (hit) return hit;
    if (!this.alive) return Promise.resolve(null);
    const p = new Promise<Uint8Array | null>((resolve) => {
      const done = (c: Uint8Array | null) => { clearTimeout(t); if (this.resolvers.get(i) === done) this.resolvers.delete(i); this.reasm.drop(i); resolve(c); };
      const t = setTimeout(() => done(null), CHUNK_MS);
      this.resolvers.set(i, done);
      try { this.ch.send(encodeWant(i)); } catch { done(null); }
    }).then(async (c) => (c && (await sha256hex(c)) === this.manifest.leaves[i] ? c : null))
      .finally(() => { if (this.pending.get(i) === p) this.pending.delete(i); });
    this.pending.set(i, p);
    return p;
  }

  close() { try { this.ch.close(); } catch {} try { this.pc.close(); } catch {} try { this.ws.close(); } catch {} }
}

type Deps = {
  openSession: (driveId: string, path: string) => Promise<P2PSession | null>;
  fetch: typeof fetch;
  now: () => number;
};

/** The direct path with its dependencies injected (tests); `p2p` below is the browser's. */
export function createP2P(deps: Deps) {
  const open = new Map<string, Promise<P2PSession | null>>();
  const failedUntil = new Map<string, number>(); // per drive (review I1)
  const stats = { p2pBytes: 0, serverBytes: 0, sessions: 0, disabled: false, closeAll: () => { for (const s of open.values()) void s.then((x) => x?.close()); open.clear(); } };

  async function session(driveId: string, path: string): Promise<P2PSession | null> {
    if (stats.disabled || (failedUntil.get(driveId) ?? 0) > deps.now()) return null;
    const k = `${driveId}\0${path}`;
    const cur = open.get(k);
    if (cur) {
      const s = await cur;
      if (s?.alive) return s;
      open.delete(k); // the channel went away: try the direct path again
    }
    const p = deps.openSession(driveId, path);
    open.set(k, p);
    const s = await p;
    if (!s) { open.delete(k); failedUntil.set(driveId, deps.now() + FAILED_RETRY_MS); }
    else stats.sessions++;
    return s;
  }

  /** Bytes [start, end] (inclusive, like a Range): device first, server for anything it does not bring; every chunk verified. */
  async function range(driveId: string, path: string, start: number, endInclusive: number | null): Promise<{ size: number; stream: ReadableStream<Uint8Array> } | null> {
    const s = await session(driveId, path);
    if (!s) return null;
    const { size, leaves } = s.manifest;
    const end = Math.min(endInclusive ?? size - 1, size - 1);
    if (start > end) return null;
    let i = Math.floor(start / C);
    const last = Math.floor(end / C);
    const serverUrl = `/api/drives/${encodeURIComponent(driveId)}/fs/stream?path=${encodeURIComponent(path)}&via=server`;

    // the whole chunk from the server, verified like a device chunk (review I2)
    const fromServer = async (idx: number): Promise<Uint8Array> => {
      const want = Math.min(C, size - idx * C);
      const r = await deps.fetch(serverUrl, { headers: { range: `bytes=${idx * C}-${idx * C + want - 1}` } } as RequestInit);
      if (r.status !== 206) throw new Error(`server answered ${r.status}`);
      const b = new Uint8Array(await r.arrayBuffer());
      if (b.length !== want || (await sha256hex(b)) !== leaves[idx]) throw new Error("the file changed while playing");
      stats.serverBytes += b.length;
      return b;
    };

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (i > last) { controller.close(); return; }
        try {
          const from = Math.max(start - i * C, 0);
          const to = Math.min(end - i * C, C - 1);
          const device = s.alive ? await s.chunk(i) : null;
          const whole = device ?? (await fromServer(i));
          if (device) stats.p2pBytes += to - from + 1;
          controller.enqueue(whole.subarray(from, to + 1));
          i++;
        } catch (e) {
          controller.error(e);
        }
      },
    });
    return { size, stream };
  }

  return { range, stats };
}

// ── the browser's instance ───────────────────────────────────────────────────

const stun = () => process.env.NEXT_PUBLIC_AINDRIVE_STUN ?? "stun:stun.l.google.com:19302";

async function openBrowserSession(driveId: string, path: string): Promise<P2PSession | null> {
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
  return new P2PSession(ready, pc, ch as unknown as Chan, ws);
}

let browserP2P: ReturnType<typeof createP2P> | null = null;
function p2p() {
  if (!browserP2P) {
    browserP2P = createP2P({ openSession: openBrowserSession, fetch: (...a) => fetch(...a), now: () => Date.now() });
    (window as unknown as { __aindriveP2P: unknown }).__aindriveP2P = browserP2P.stats;
  }
  return browserP2P;
}

export const p2pRange = (driveId: string, path: string, start: number, end: number | null) => p2p().range(driveId, path, start, end);

/** The page's side of the service worker bridge: answer "p2p-range", and say yes to "p2p-ping" (a restarted worker asks). */
export function serveP2PForServiceWorker() {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
  p2p();
  navigator.serviceWorker.addEventListener("message", async (ev) => {
    const m = ev.data as { type?: string; driveId?: string; path?: string; start?: number; end?: number | null };
    const port = ev.ports[0];
    if (!port) return;
    if (m?.type === "p2p-ping") { port.postMessage({ ok: true }); return; }
    if (m?.type !== "p2p-range" || !m.driveId || !m.path) return;
    try {
      const r = await p2pRange(m.driveId, m.path, m.start ?? 0, m.end ?? null);
      if (!r) { port.postMessage({ ok: false }); return; }
      port.postMessage({ ok: true, size: r.size, stream: r.stream }, [r.stream as unknown as Transferable]);
    } catch { port.postMessage({ ok: false }); }
  });
  navigator.serviceWorker.ready.then((reg) => reg.active?.postMessage({ type: "p2p-enable" })).catch(() => {});
}
