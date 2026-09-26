import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { RTCPeerConnection, RTCIceCandidate } from "werift";
import { handleRtc, closeAllRtc } from "../media-rtc.js";
import { mintToken, encodeWant, Reassembler } from "../willow-shared/p2p.js";
import { mediaIndex } from "../media-index.js";

const C = 1048576;
const pattern = (n, salt = 0) => Buffer.from(Uint8Array.from({ length: n }, (_, i) => (i * 13 + 5 + salt) & 255));
const rootHex = (leaves) => createHash("sha256").update(Buffer.concat(leaves.map((h) => Buffer.from(h, "hex")))).digest("hex");
afterEach(() => closeAllRtc());

// A "browser" (werift) whose signalling goes through handleRtc, as the server would relay it.
async function connect({ root, secret, token, path }) {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const sid = Math.random().toString(36).slice(2);
  const fromAgent = async (frame) => {
    const d = frame.data;
    if (d?.sdp) await pc.setRemoteDescription(d);
    else if (d?.candidate) await pc.addIceCandidate(new RTCIceCandidate(d.candidate)).catch(() => {});
  };
  const send = (frame) => { void fromAgent(frame); };
  pc.onicecandidate = (e) => { if (e.candidate) void handleRtc({ type: "rtc", sid, token, path, data: { candidate: e.candidate.toJSON() } }, { root, driveSecret: secret, send }); };
  const ch = pc.createDataChannel("chunks");
  const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
  await handleRtc({ type: "rtc", sid, token, path, data: { sdp: pc.localDescription.sdp, type: "offer" } }, { root, driveSecret: secret, send });
  const opened = await Promise.race([new Promise((r) => { ch.onopen = () => r(true); }), new Promise((r) => setTimeout(() => r(false), 8000))]);
  return { pc, ch, opened };
}

async function want(ch, index) {
  const r = new Reassembler();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no chunk")), 8000);
    ch.onmessage = (m) => { const got = r.push(new Uint8Array(m.data)); if (got) { clearTimeout(t); resolve(got); } };
    ch.send(encodeWant(index));
  });
}

describe("agent answers P2P and serves chunks", () => {
  it("serves verified chunks of the token's file", async () => {
    const root = mkdtempSync(join(tmpdir(), "rtc-"));
    const file = pattern(3 * C + C / 2);
    writeFileSync(join(root, "v.mp4"), file);
    const idx = await mediaIndex(join(root, "v.mp4"));
    const token = mintToken("sec", { drive: "d", path: "v.mp4", root: rootHex(idx.leaves), exp: Date.now() + 60_000 });
    const { ch, opened } = await connect({ root, secret: "sec", token, path: "v.mp4" });
    expect(opened).toBe(true);
    for (const i of [0, 3]) {
      const { index, chunk } = await want(ch, i);
      expect(index).toBe(i);
      expect(createHash("sha256").update(chunk).digest("hex")).toBe(idx.leaves[i]);
      expect(Buffer.from(chunk).equals(file.subarray(i * C, (i + 1) * C))).toBe(true);
    }
  }, 30000);

  it("a token for another path gets no answer", async () => {
    const root = mkdtempSync(join(tmpdir(), "rtc-"));
    writeFileSync(join(root, "v.mp4"), pattern(10));
    writeFileSync(join(root, "secret.mp4"), pattern(10, 1));
    const token = mintToken("sec", { drive: "d", path: "v.mp4", root: "00".repeat(32), exp: Date.now() + 60_000 });
    const { opened } = await connect({ root, secret: "sec", token, path: "secret.mp4" });
    expect(opened).toBe(false);
  }, 20000);

  it("a file changed after the token was minted is not served", async () => {
    const root = mkdtempSync(join(tmpdir(), "rtc-"));
    writeFileSync(join(root, "v.mp4"), pattern(2 * C));
    const idx = await mediaIndex(join(root, "v.mp4"));
    const token = mintToken("sec", { drive: "d", path: "v.mp4", root: rootHex(idx.leaves), exp: Date.now() + 60_000 });
    const { ch, opened } = await connect({ root, secret: "sec", token, path: "v.mp4" });
    expect(opened).toBe(true);
    writeFileSync(join(root, "v.mp4"), pattern(2 * C, 3));
    utimesSync(join(root, "v.mp4"), new Date(), new Date(Date.now() + 10_000));
    await expect(want(ch, 0)).rejects.toThrow();
  }, 30000);
});
