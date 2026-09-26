// The direct device → browser path, agent side (P2P media spec M5). The server
// relays signalling; every frame carries a token it minted (drive, path, content
// root, expiry) with this drive's secret. The agent answers only a valid token whose
// path matches, and on the data channel serves chunks of that one file, only while
// the file still has the content the token names.
import { statSync } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { RTCPeerConnection, RTCIceCandidate } from "werift";
import { safeResolve } from "./rpc.js";
import { CHUNK } from "./media-index.js";
import { verifyToken, encodePieces } from "./willow-shared/p2p.js";

const IDLE_MS = 10 * 60_000;
const MAX_SESSIONS = 8; // per drive (review I4)
const SEND_HIGH = 1 << 20; // wait while more than 1 MiB is queued on the channel
const sessions = new Map(); // sid → { pc, claim, timer, queue }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readChunk(abs, index, size) {
  const length = Math.max(0, Math.min(CHUNK, size - index * CHUNK));
  const buf = Buffer.alloc(length);
  const fh = await openFile(abs, "r"); // async: a 1 MiB read never blocks the agent
  try { await fh.read(buf, 0, length, index * CHUNK); } finally { await fh.close(); }
  return buf;
}

function close(sid) {
  const s = sessions.get(sid);
  if (!s) return;
  sessions.delete(sid);
  clearTimeout(s.timer);
  try { s.pc.close(); } catch {}
}

export function closeAllRtc() { for (const sid of [...sessions.keys()]) close(sid); }

/**
 * One signalling frame from the server: `{ type: "rtc", sid, token, path, data }`.
 * `send(frame)` goes back to the server for the browser of `sid`.
 */
export async function handleRtc(frame, { root, driveSecret, send, iceServers = [], log = { warn() {} } }) {
  const { sid, token, path, data } = frame ?? {};
  if (typeof sid !== "string" || !data) return;
  const claim = verifyToken(driveSecret, token, Date.now());
  if (!claim || claim.path !== path) return; // not ours to serve: no answer at all
  if (data.bye) return close(sid);

  let s = sessions.get(sid);
  const touch = () => { if (!s) return; clearTimeout(s.timer); s.timer = setTimeout(() => close(sid), IDLE_MS); };

  if (data.sdp && data.type === "offer" && !s) {
    if (sessions.size >= MAX_SESSIONS) { log.warn({}, "p2p: too many sessions, not answering"); return; }
    const pc = new RTCPeerConnection({ iceServers });
    s = { pc, claim, timer: null, queue: Promise.resolve() };
    sessions.set(sid, s);
    touch();
    pc.onicecandidate = (e) => { if (e.candidate) send({ type: "rtc", sid, data: { candidate: e.candidate.toJSON() } }); };
    pc.ondatachannel = (ev) => {
      const ch = ev.channel;
      const serve = async (want) => {
        if (Date.now() > claim.exp) { close(sid); return; } // the token ran out (review M1)
        const abs = safeResolve(root, claim.path);
        const st = statSync(abs);
        if (st.size !== claim.size || st.mtimeMs !== claim.mtimeMs) { close(sid); return; } // the file changed: no re-hash (review I4)
        if (want * CHUNK >= claim.size) return;
        for (const piece of encodePieces(want, await readChunk(abs, want, claim.size))) {
          while (ch.bufferedAmount > SEND_HIGH && ch.readyState === "open") await sleep(10); // backpressure
          if (ch.readyState !== "open") return;
          ch.send(Buffer.from(piece));
        }
      };
      ch.onmessage = (m) => {
        touch();
        let want;
        try { want = JSON.parse(String(m.data)).want; } catch { return; }
        if (!Number.isInteger(want) || want < 0) return;
        // one chunk at a time per session: a viewer cannot flood the uplink (review I4)
        s.queue = s.queue.then(() => serve(want)).catch((e) => log.warn({ err: e.message }, "p2p: chunk not served"));
      };
    };
    await pc.setRemoteDescription({ type: "offer", sdp: data.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ type: "rtc", sid, data: { type: "answer", sdp: pc.localDescription.sdp } });
    return;
  }
  if (data.candidate && s) {
    touch();
    await s.pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
  }
}
