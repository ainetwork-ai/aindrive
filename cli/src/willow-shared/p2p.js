// GENERATED from web/shared/media/p2p.ts by web/scripts/mirror-willow-to-cli.mjs — do not edit.
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalJson, equalBytes } from "./bytes.js";
const PIECE = 65536;
const CHUNK_MAX = 1048576;
const HEADER = 12;
const encodeWant = (index) => JSON.stringify({ want: index });
function encodePieces(index, chunk) {
  const out = [];
  for (let off = 0; off < chunk.length || off === 0 && chunk.length === 0; off += PIECE) {
    const body = chunk.subarray(off, off + PIECE);
    const f = new Uint8Array(HEADER + body.length);
    const v = new DataView(f.buffer);
    v.setUint32(0, index);
    v.setUint32(4, off);
    v.setUint32(8, chunk.length);
    f.set(body, HEADER);
    out.push(f);
    if (chunk.length === 0) break;
  }
  return out;
}
class Reassembler {
  parts = /* @__PURE__ */ new Map();
  push(frame) {
    if (frame.length < HEADER) throw new Error("short piece");
    const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const index = v.getUint32(0), offset = v.getUint32(4), total = v.getUint32(8);
    const body = frame.subarray(HEADER);
    if (total > CHUNK_MAX) throw new Error("chunk too large");
    if (offset % PIECE !== 0 || body.length > PIECE || offset + body.length > total) throw new Error("piece outside its chunk");
    let p = this.parts.get(index);
    if (!p) {
      p = { total, buf: new Uint8Array(total), got: 0, seen: /* @__PURE__ */ new Set() };
      this.parts.set(index, p);
    }
    if (p.total !== total) throw new Error("piece from a different chunk");
    if (!p.seen.has(offset)) {
      p.seen.add(offset);
      p.buf.set(body, offset);
      p.got += body.length;
    }
    if (p.got < p.total) return null;
    this.parts.delete(index);
    return { index, chunk: p.buf };
  }
  /** Forget a chunk being assembled (it came from elsewhere, or timed out). */
  drop(index) {
    this.parts.delete(index);
  }
}
const b64u = (b) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const sign = (secret, body) => hmac(sha256, new TextEncoder().encode(`aindrive-p2p/v1/${secret}`), body);
function mintToken(secret, claim) {
  const body = canonicalJson(claim);
  return `${b64u(body)}.${b64u(sign(secret, body))}`;
}
function verifyToken(secret, token, now) {
  const [a, b] = String(token).split(".");
  if (!a || !b) return null;
  try {
    const body = unb64u(a);
    if (!equalBytes(sign(secret, body), unb64u(b))) return null;
    const c = JSON.parse(new TextDecoder().decode(body));
    if (typeof c.drive !== "string" || typeof c.path !== "string" || typeof c.root !== "string" || typeof c.exp !== "number") return null;
    return now <= c.exp ? c : null;
  } catch {
    return null;
  }
}
export {
  PIECE,
  Reassembler,
  encodePieces,
  encodeWant,
  mintToken,
  verifyToken
};
