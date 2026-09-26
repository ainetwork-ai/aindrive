import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { RTCPeerConnection, RTCIceCandidate } from "werift";
import { createPhoneRtc } from "../p2p";
import { mintToken, encodeWant, Reassembler } from "../willow-shared/p2p";

const C = 1048576;
const file = Buffer.from(Uint8Array.from({ length: 2 * C + 777 }, (_, i) => (i * 11 + 1) & 255));
const leaf = (i: number) => createHash("sha256").update(file.subarray(i * C, (i + 1) * C)).digest("hex");
const secrets = new Map([["drive-1", "sec"]]);

function phone(stat = { size: file.length, mtimeMs: 5 }) {
  const toBrowser: ((f: { sid: string; data: any }) => void)[] = [];
  const rtc = createPhoneRtc({
    RTCPeerConnection: RTCPeerConnection as never,
    iceCandidate: (c) => new RTCIceCandidate(c as never) as never,
    readChunk: async (_d, _p, offset, length) => new Uint8Array(file.subarray(offset, offset + length)),
    statFile: async () => stat,
    send: (_d, f) => toBrowser.forEach((cb) => cb(f as never)),
    secretOf: (d) => secrets.get(d) ?? null,
    sendable: (u8) => Buffer.from(u8),
  });
  return { rtc, toBrowser };
}

async function browser(p: ReturnType<typeof phone>, token: string, path: string) {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const sid = Math.random().toString(36).slice(2);
  p.toBrowser.push(async (f) => { if (f.sid !== sid) return; if (f.data?.sdp) await pc.setRemoteDescription(f.data); else if (f.data?.candidate) await pc.addIceCandidate(new RTCIceCandidate(f.data.candidate)).catch(() => {}); });
  pc.onicecandidate = (e) => { if (e.candidate) void p.rtc.handle("drive-1", { type: "rtc", sid, token, path, data: { candidate: e.candidate.toJSON() } }); };
  const ch = pc.createDataChannel("chunks");
  await pc.setLocalDescription(await pc.createOffer());
  await p.rtc.handle("drive-1", { type: "rtc", sid, token, path, data: { type: "offer", sdp: pc.localDescription!.sdp } });
  const opened = await Promise.race([new Promise<boolean>((r) => { ch.onopen = () => r(true); }), new Promise<boolean>((r) => setTimeout(() => r(false), 8000))]);
  const want = (i: number) => new Promise<Uint8Array>((resolve, reject) => {
    const r = new Reassembler();
    const t = setTimeout(() => reject(new Error("no chunk")), 6000);
    ch.onmessage = (m) => { const got = r.push(new Uint8Array(m.data as Buffer)); if (got) { clearTimeout(t); resolve(got.chunk); } };
    ch.send(encodeWant(i));
  });
  return { opened, want };
}

const tok = (claim: Partial<{ path: string; exp: number; size: number; mtimeMs: number }> = {}) =>
  mintToken("sec", { drive: "drive-1", path: "v.mp4", root: "ab".repeat(32), exp: Date.now() + 60_000, size: file.length, mtimeMs: 5, ...claim });

describe("the phone answers P2P", () => {
  it("serves verified chunks of the token's file", async () => {
    const b = await browser(phone(), tok(), "v.mp4");
    expect(b.opened).toBe(true);
    const c = await b.want(2);
    expect(createHash("sha256").update(c).digest("hex")).toBe(leaf(2));
  }, 30000);

  it("a token for another path: no answer", async () => {
    const b = await browser(phone(), tok(), "other.mp4");
    expect(b.opened).toBe(false);
  }, 20000);

  it("a file that changed since the token: nothing served", async () => {
    const b = await browser(phone({ size: file.length, mtimeMs: 6 }), tok(), "v.mp4");
    expect(b.opened).toBe(true);
    await expect(b.want(0)).rejects.toThrow();
  }, 30000);
});
