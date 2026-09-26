/**
 * The phone as a P2P media peer (web docs/superpowers/plans/2026-09-26-phone-p2p.md).
 *
 * The native agent keeps the drive's socket but has no WebRTC stack; this WebView
 * does. The native side hands over each `{type: "rtc"}` frame the server relays;
 * this answers with RTCPeerConnection and serves chunks of the one file the token
 * names, read through the plugin. Same rules as the desktop agent
 * (cli/src/media-rtc.js): the token must be valid and name this path; at most 8
 * sessions; one chunk at a time with send backpressure; the file must still have
 * the size and mtime the token names; nothing after the token expires.
 *
 * Only while the app is in the foreground — a backgrounded WebView sleeps and the
 * browser then plays from the server's cache.
 */
import { verifyToken, encodePieces, type P2PClaim } from "./willow-shared/p2p";

const CHUNK = 1048576;
const MAX_SESSIONS = 8;
const IDLE_MS = 10 * 60_000;
const SEND_HIGH = 1 << 20;

type Frame = { type: "rtc"; sid?: string; token?: string; path?: string; data?: { type?: string; sdp?: string; candidate?: unknown; bye?: boolean } };
type Chan = { readyState: string; bufferedAmount: number; send(d: unknown): void; onmessage: ((m: { data: unknown }) => void) | null };
type PC = {
  onicecandidate: ((e: { candidate: { toJSON(): unknown } | null }) => void) | null;
  ondatachannel: ((e: { channel: Chan }) => void) | null;
  setRemoteDescription(d: { type: string; sdp: string }): Promise<void>;
  createAnswer(): Promise<unknown>;
  setLocalDescription(d: unknown): Promise<void>;
  localDescription: { sdp: string } | null;
  addIceCandidate(c: unknown): Promise<void>;
  close(): void;
};

export type PhoneRtcDeps = {
  RTCPeerConnection: new (cfg: { iceServers: { urls: string }[] }) => PC;
  iceCandidate?: (c: unknown) => unknown;
  readChunk(driveId: string, path: string, offset: number, length: number): Promise<Uint8Array>;
  statFile(driveId: string, path: string): Promise<{ size: number; mtimeMs: number } | null>;
  send(driveId: string, frame: { type: "rtc"; sid: string; data: unknown }): void;
  secretOf(driveId: string): string | null;
  iceServers?: { urls: string }[];
  /** What the data channel's send() takes (the browser takes a Uint8Array). */
  sendable?: (u8: Uint8Array) => unknown;
  log?: (msg: string) => void;
};

export function createPhoneRtc(deps: PhoneRtcDeps) {
  type Session = { pc: PC; claim: P2PClaim; driveId: string; timer: ReturnType<typeof setTimeout> | null; queue: Promise<void> };
  const sessions = new Map<string, Session>();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const close = (sid: string) => {
    const s = sessions.get(sid);
    if (!s) return;
    sessions.delete(sid);
    if (s.timer) clearTimeout(s.timer);
    try { s.pc.close(); } catch { /* already closed */ }
  };

  async function handle(driveId: string, frame: Frame): Promise<void> {
    const { sid, token, path, data } = frame ?? ({} as Frame);
    if (typeof sid !== "string" || !data) return;
    const secret = deps.secretOf(driveId);
    const claim = secret ? verifyToken(secret, token ?? "", Date.now()) : null;
    if (!claim || claim.path !== path || claim.drive !== driveId) return; // not ours: no answer at all
    if (data.bye) return close(sid);

    let s = sessions.get(sid);
    const touch = () => { if (!s) return; if (s.timer) clearTimeout(s.timer); s.timer = setTimeout(() => close(sid), IDLE_MS); };

    if (data.type === "offer" && data.sdp && !s) {
      const perDrive = [...sessions.values()].filter((x) => x.driveId === driveId).length;
      if (perDrive >= MAX_SESSIONS) { deps.log?.("p2p: too many sessions"); return; }
      const pc = new deps.RTCPeerConnection({ iceServers: deps.iceServers ?? [] });
      const session: Session = { pc, claim, driveId, timer: null, queue: Promise.resolve() };
      s = session;
      sessions.set(sid, session);
      touch();
      pc.onicecandidate = (e) => { if (e.candidate) deps.send(driveId, { type: "rtc", sid, data: { candidate: e.candidate.toJSON() } }); };
      pc.ondatachannel = (ev) => {
        const ch = ev.channel;
        const serve = async (want: number) => {
          if (Date.now() > claim.exp) { close(sid); return; }
          const st = await deps.statFile(driveId, claim.path);
          if (!st || st.size !== claim.size || st.mtimeMs !== claim.mtimeMs) { close(sid); return; } // the file changed
          if (want * CHUNK >= claim.size) return;
          const bytes = await deps.readChunk(driveId, claim.path, want * CHUNK, Math.min(CHUNK, claim.size - want * CHUNK));
          for (const piece of encodePieces(want, bytes)) {
            while (ch.bufferedAmount > SEND_HIGH && ch.readyState === "open") await sleep(10);
            if (ch.readyState !== "open") return;
            ch.send(deps.sendable ? deps.sendable(piece) : piece);
          }
        };
        ch.onmessage = (m) => {
          touch();
          let want: unknown;
          try { want = JSON.parse(typeof m.data === "string" ? m.data : new TextDecoder().decode(m.data as Uint8Array)).want; } catch { return; }
          if (!Number.isInteger(want) || (want as number) < 0) return;
          session.queue = session.queue.then(() => serve(want as number)).catch((e) => deps.log?.(`p2p: chunk not served: ${(e as Error).message}`));
        };
      };
      try {
        await pc.setRemoteDescription({ type: "offer", sdp: data.sdp });
        await pc.setLocalDescription(await pc.createAnswer());
      } catch (e) {
        close(sid); // a failed setup must not hold one of the drive's session slots
        deps.log?.(`p2p: offer not answered: ${(e as Error).message}`);
        return;
      }
      deps.send(driveId, { type: "rtc", sid, data: { type: "answer", sdp: pc.localDescription!.sdp } });
      return;
    }
    if (data.candidate && s) {
      touch();
      await s.pc.addIceCandidate(deps.iceCandidate ? deps.iceCandidate(data.candidate) : data.candidate).catch(() => {});
    }
  }

  return { handle, closeAll: () => { for (const sid of [...sessions.keys()]) close(sid); } };
}
