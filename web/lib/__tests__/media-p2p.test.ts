import { describe, it, expect } from "vitest";
import { PIECE, encodePieces, Reassembler, mintToken, verifyToken } from "@/shared/media/p2p";

const chunkOf = (n: number, salt = 0) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + salt) & 255);
const shuffle = <T,>(a: T[]) => a.map((x) => [Math.sin(a.indexOf(x) * 999) , x] as const).sort((p, q) => p[0] - q[0]).map((p) => p[1]);

describe("P2P chunk wire", () => {
  it("a full chunk and a short last chunk survive pieces in any order", () => {
    for (const [index, n] of [[0, 1048576], [3, 12345]] as const) {
      const c = chunkOf(n, index);
      const pieces = encodePieces(index, c);
      expect(pieces.every((p) => p.length <= PIECE + 12)).toBe(true);
      const r = new Reassembler();
      let got: { index: number; chunk: Uint8Array } | null = null;
      for (const p of shuffle(pieces)) got = r.push(p) ?? got;
      expect(got?.index).toBe(index);
      expect(Buffer.from(got!.chunk).equals(Buffer.from(c))).toBe(true);
    }
  });

  it("rejects a piece past the chunk, a changed total, or more than 1 MiB", () => {
    const r = new Reassembler();
    const bad = new Uint8Array(12 + 10);
    const v = new DataView(bad.buffer);
    v.setUint32(0, 1); v.setUint32(4, 100); v.setUint32(8, 50); // offset 100 + 10 > total 50
    expect(() => r.push(bad)).toThrow();
    const [first] = encodePieces(2, chunkOf(200000));
    r.push(first);
    const other = encodePieces(2, chunkOf(300000))[1];
    expect(() => r.push(other)).toThrow();
    const huge = new Uint8Array(12); new DataView(huge.buffer).setUint32(8, 1048577);
    expect(() => r.push(huge)).toThrow();
  });
});

describe("P2P token", () => {
  const claim = { drive: "d1", path: "v.mp4", root: "ab".repeat(32), exp: 2000, size: 10, mtimeMs: 1 };
  it("verifies exactly the claim it was minted for, until it expires", () => {
    const t = mintToken("secret", claim);
    expect(verifyToken("secret", t, 1000)).toEqual(claim);
    expect(verifyToken("secret", t, 2001)).toBeNull();
    expect(verifyToken("other", t, 1000)).toBeNull();
    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...claim, path: "secret.mp4" })).toString("base64url");
    expect(verifyToken("secret", `${forged}.${sig}`, 1000)).toBeNull();
    expect(verifyToken("secret", `${body}.`, 1000)).toBeNull();
  });
});

describe("P2P review fixes", () => {
  it("M4: pieces for a chunk nobody asked for are dropped, and at most 4 chunks assemble at once", () => {
    const wanted = new Set([1]);
    const r = new Reassembler({ accept: (i) => wanted.has(i), maxOpen: 4 });
    const [p] = encodePieces(7, chunkOf(100000));
    expect(r.push(p)).toBeNull();
    expect(r.openCount).toBe(0);
    const r2 = new Reassembler({ maxOpen: 4 });
    for (const i of [1, 2, 3, 4]) r2.push(encodePieces(i, chunkOf(100000))[0]);
    expect(() => r2.push(encodePieces(5, chunkOf(100000))[0])).toThrow();
  });

  it("the token claim carries size and mtime", () => {
    const c = { drive: "d", path: "p", root: "ab".repeat(32), exp: 5, size: 10, mtimeMs: 3 };
    expect(verifyToken("s", mintToken("s", c), 1)).toEqual(c);
  });
});
