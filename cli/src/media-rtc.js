// The direct device → browser path, agent side (P2P media spec M5). The server
// relays signalling; every frame carries a token it minted (drive, path, content
// root, expiry) with this drive's secret. The agent answers only a valid token whose
// path matches, and on the data channel serves chunks of that one file, only while
// the file still has the content the token names.
import { createHash } from "node:crypto";
import { openSync, readSync, closeSync } from "node:fs";
import { RTCPeerConnection, RTCIceCandidate } from "werift";
import { safeResolve } from "./rpc.js";
import { mediaIndex, CHUNK } from "./media-index.js";
import { verifyToken, encodePieces } from "./willow-shared/p2p.js";

const IDLE_MS = 10 * 60_000;
const sessions = new Map(); // sid → { pc, claim, timer }

const rootOf = (leaves) => createHash("sha256").update(Buffer.concat(leaves.map((h) => Buffer.from(h, "hex")))).digest("hex");

function readChunk(abs, index, size) {
  const length = Math.min(CHUNK, size - index * CHUNK);
  const buf = Buffer.alloc(Math.max(0, length));
  const fd = openSync(abs, "r");
  try { readSync(fd, buf, 0, buf.length, index * CHUNK); } finally { closeSync(fd); }
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
    const pc = new RTCPeerConnection({ iceServers });
    s = { pc, claim, timer: null };
    sessions.set(sid, s);
    touch();
    pc.onicecandidate = (e) => { if (e.candidate) send({ type: "rtc", sid, data: { candidate: e.candidate.toJSON() } }); };
    pc.ondatachannel = (ev) => {
      const ch = ev.channel;
      ch.onmessage = async (m) => {
        touch();
        let want;
        try { want = JSON.parse(String(m.data)).want; } catch { return; }
        if (!Number.isInteger(want) || want < 0) return;
        try {
          const abs = safeResolve(root, claim.path);
          const idx = await mediaIndex(abs);
          if (rootOf(idx.leaves) !== claim.root) { close(sid); return; } // the file changed: the token no longer describes it
          if (want >= idx.leaves.length) return;
          for (const piece of encodePieces(want, readChunk(abs, want, idx.size))) ch.send(Buffer.from(piece));
        } catch (e) { log.warn({ err: e.message }, "p2p: chunk not served"); }
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
