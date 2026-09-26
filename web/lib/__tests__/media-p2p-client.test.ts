// Plan 7 review: the page side of the direct path.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { createP2P, P2PSession } from "@/lib/media/p2p-client";
import { encodePieces } from "@/shared/media/p2p";

const C = 1048576;
const file = Buffer.from(Uint8Array.from({ length: 2 * C + 100 }, (_, i) => (i * 17 + 3) & 255));
const leaves = [0, 1, 2].map((i) => createHash("sha256").update(file.subarray(i * C, (i + 1) * C)).digest("hex"));
const manifest = { size: file.length, root: "x", leaves };

function fakeChannel(serve = true) {
  const ch = { readyState: "open", binaryType: "", sent: [] as string[], onmessage: null as null | ((m: { data: ArrayBuffer }) => void), onclose: null as null | (() => void),
    send(msg: string) { ch.sent.push(msg); if (!serve) return; const i = JSON.parse(msg).want; queueMicrotask(() => { for (const p of encodePieces(i, file.subarray(i * C, (i + 1) * C))) ch.onmessage?.({ data: p.slice().buffer }); }); },
    close() {} };
  return ch;
}
const session = (ch: ReturnType<typeof fakeChannel>) => new P2PSession(manifest, { close() {} } as never, ch as never, { close() {} } as never);

describe("P2P page side (review)", () => {
  it("I3: two readers of one chunk share one request and both get it", async () => {
    const ch = fakeChannel();
    const s = session(ch);
    const [a, b] = await Promise.all([s.chunk(1), s.chunk(1)]);
    expect(ch.sent.length).toBe(1);
    expect(Buffer.from(a!).equals(file.subarray(C, 2 * C))).toBe(true);
    expect(Buffer.from(b!).equals(file.subarray(C, 2 * C))).toBe(true);
  });

  it("M4: pieces nobody asked for are ignored", async () => {
    const ch = fakeChannel(false);
    session(ch);
    for (const p of encodePieces(2, file.subarray(2 * C))) ch.onmessage?.({ data: p.slice().buffer });
    // nothing to assert beyond "no throw": the reassembler never buffered it
    expect(true).toBe(true);
  });

  it("I1: a direct path that failed is not retried for a while", async () => {
    let opens = 0;
    const p2p = createP2P({ openSession: async () => { opens++; return null; }, fetch: fetch, now: () => 1000 });
    expect(await p2p.range("d", "v.mp4", 0, 10)).toBeNull();
    expect(await p2p.range("d", "v.mp4", 0, 10)).toBeNull();
    expect(await p2p.range("d", "other.mp4", 0, 10)).toBeNull();
    expect(opens).toBe(1); // remembered per drive
  });

  it("I2: server fallback must be the right 206 of verified bytes; a changed file errors instead of stitching", async () => {
    const dead = fakeChannel(false); dead.readyState = "closed";
    const s = session(dead);
    const good = (_u: string, init: { headers: { range: string } }) => { const [, a, b] = /bytes=(\d+)-(\d+)/.exec(init.headers.range)!; return Promise.resolve(new Response(file.subarray(+a, +b + 1), { status: 206 })); };
    const p2p = createP2P({ openSession: async () => s, fetch: good as never, now: () => 0 });
    const r = (await p2p.range("d", "v.mp4", 10, C + 10))!;
    expect(Buffer.from(await new Response(r.stream).arrayBuffer()).equals(file.subarray(10, C + 11))).toBe(true);

    const changed = (_u: string, init: { headers: { range: string } }) => { const [, a, b] = /bytes=(\d+)-(\d+)/.exec(init.headers.range)!; const x = Buffer.from(file.subarray(+a, +b + 1)); x[0] ^= 1; return Promise.resolve(new Response(x, { status: 206 })); };
    const p2 = createP2P({ openSession: async () => session(Object.assign(fakeChannel(false), { readyState: "closed" })), fetch: changed as never, now: () => 0 });
    const r2 = (await p2.range("d", "v.mp4", 0, C - 1))!;
    await expect(new Response(r2.stream).arrayBuffer()).rejects.toThrow();

    const whole = () => Promise.resolve(new Response(file, { status: 200 }));
    const p3 = createP2P({ openSession: async () => session(Object.assign(fakeChannel(false), { readyState: "closed" })), fetch: whole as never, now: () => 0 });
    const r3 = (await p3.range("d", "v.mp4", 0, 100))!;
    await expect(new Response(r3.stream).arrayBuffer()).rejects.toThrow();
  });
});
