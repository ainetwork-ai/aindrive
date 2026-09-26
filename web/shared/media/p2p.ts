// The direct device → browser path (P2P media spec M5): the data channel wire and
// the signalling token. Pure; mirrored into the CLI (web/scripts/mirror-willow-to-cli.mjs).
//
// Wire: the browser sends text frames {"want": <chunk index>}; the device answers
// with binary pieces `u32 index | u32 offset | u32 total | bytes` of at most PIECE
// bytes (browser SCTP message limits). The receiver reassembles a chunk and then
// verifies it against the chunk hash list before using it.
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalJson, equalBytes } from "../willow/bytes";

export const PIECE = 65536;
const CHUNK_MAX = 1048576;
const HEADER = 12;

export const encodeWant = (index: number): string => JSON.stringify({ want: index });

export function encodePieces(index: number, chunk: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let off = 0; off < chunk.length || (off === 0 && chunk.length === 0); off += PIECE) {
    const body = chunk.subarray(off, off + PIECE);
    const f = new Uint8Array(HEADER + body.length);
    const v = new DataView(f.buffer);
    v.setUint32(0, index); v.setUint32(4, off); v.setUint32(8, chunk.length);
    f.set(body, HEADER);
    out.push(f);
    if (chunk.length === 0) break;
  }
  return out;
}

/** Collects pieces into whole chunks; throws on a piece that cannot belong to one. */
export class Reassembler {
  private readonly parts = new Map<number, { total: number; buf: Uint8Array; got: number; seen: Set<number> }>();

  push(frame: Uint8Array): { index: number; chunk: Uint8Array } | null {
    if (frame.length < HEADER) throw new Error("short piece");
    const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const index = v.getUint32(0), offset = v.getUint32(4), total = v.getUint32(8);
    const body = frame.subarray(HEADER);
    if (total > CHUNK_MAX) throw new Error("chunk too large");
    if (offset % PIECE !== 0 || body.length > PIECE || offset + body.length > total) throw new Error("piece outside its chunk");
    let p = this.parts.get(index);
    if (!p) { p = { total, buf: new Uint8Array(total), got: 0, seen: new Set() }; this.parts.set(index, p); }
    if (p.total !== total) throw new Error("piece from a different chunk");
    if (!p.seen.has(offset)) { p.seen.add(offset); p.buf.set(body, offset); p.got += body.length; }
    if (p.got < p.total) return null;
    this.parts.delete(index);
    return { index, chunk: p.buf };
  }

  /** Forget a chunk being assembled (it came from elsewhere, or timed out). */
  drop(index: number) { this.parts.delete(index); }
}

// ── signalling token: the server vouches that this browser may read this content ──

export type P2PClaim = { drive: string; path: string; root: string; exp: number };

// base64url without Buffer: this module also runs in the browser
const b64u = (b: Uint8Array) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const sign = (secret: string, body: Uint8Array) => hmac(sha256, new TextEncoder().encode(`aindrive-p2p/v1/${secret}`), body);

export function mintToken(secret: string, claim: P2PClaim): string {
  const body = canonicalJson(claim);
  return `${b64u(body)}.${b64u(sign(secret, body))}`;
}

export function verifyToken(secret: string, token: string, now: number): P2PClaim | null {
  const [a, b] = String(token).split(".");
  if (!a || !b) return null;
  try {
    const body = unb64u(a);
    if (!equalBytes(sign(secret, body), unb64u(b))) return null;
    const c = JSON.parse(new TextDecoder().decode(body)) as P2PClaim;
    if (typeof c.drive !== "string" || typeof c.path !== "string" || typeof c.root !== "string" || typeof c.exp !== "number") return null;
    return now <= c.exp ? c : null;
  } catch { return null; }
}
