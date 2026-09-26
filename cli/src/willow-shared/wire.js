// GENERATED from web/shared/willow/wire.ts by web/scripts/mirror-willow-to-cli.mjs — do not edit.
import { OPEN_END } from "@jsr/earthstar__willow-utils";
import { fromHex, toHex } from "./bytes.js";
const b64 = (b) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const end = (v, f) => v === OPEN_END ? null : f(v);
function encodeRange(r) {
  return {
    s: [toHex(r.subspaceRange.start), end(r.subspaceRange.end, toHex)],
    p: [r.pathRange.start.map(toHex), end(r.pathRange.end, (p) => p.map(toHex))],
    t: [r.timeRange.start.toString(), end(r.timeRange.end, (x) => x.toString())]
  };
}
function decodeRange(j) {
  const o = j;
  return {
    subspaceRange: { start: fromHex(o.s[0]), end: o.s[1] === null ? OPEN_END : fromHex(o.s[1]) },
    pathRange: { start: o.p[0].map(fromHex), end: o.p[1] === null ? OPEN_END : o.p[1].map(fromHex) },
    timeRange: { start: BigInt(o.t[0]), end: o.t[1] === null ? OPEN_END : BigInt(o.t[1]) }
  };
}
function encodeEntry(e) {
  const x = e.entry;
  return {
    s: toHex(x.subspaceId),
    p: x.path.map(toHex),
    ts: x.timestamp.toString(),
    n: x.payloadLength.toString(),
    d: toHex(x.payloadDigest),
    tok: toHex(e.token),
    pl: e.payload ? b64(e.payload) : void 0
  };
}
function decodeEntry(j, namespace) {
  const o = j;
  return {
    entry: { namespaceId: namespace, subspaceId: fromHex(o.s), path: o.p.map(fromHex), timestamp: BigInt(o.ts), payloadLength: BigInt(o.n), payloadDigest: fromHex(o.d) },
    token: fromHex(o.tok),
    payload: o.pl === void 0 ? void 0 : unb64(o.pl)
  };
}
export {
  decodeEntry,
  decodeRange,
  encodeEntry,
  encodeRange
};
