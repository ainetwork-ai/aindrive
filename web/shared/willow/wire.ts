// web/shared/willow/wire.ts
// The sync wire (plan 2 ruling): JSON text frames. Bytes are hex, payloads base64,
// bigints decimal strings, OPEN_END is null. Entries carry their token (the
// device's signature) so every receiver re-checks it.
import { OPEN_END, type Entry, type Range3d } from "@jsr/earthstar__willow-utils";
import { fromHex, toHex } from "./bytes";

type B = Uint8Array;
export type WireEntry = { entry: Entry<B, B, B>; token: B; payload?: B };
/** `re` names the range (its encoded JSON) a frame answers, so the side that
 *  opened that range can close it; `synced` = the sender has no open range. */
export type Frame =
  | { t: "fp"; range: unknown; fp: string; size: number; re?: string }
  | { t: "eq"; re: string }
  | { t: "items"; range: unknown; entries: unknown[]; reply: boolean; re?: string; more?: boolean }
  | { t: "live"; entry: unknown }
  | { t: "refused"; path: string[]; subspace: string; reason: string }
  | { t: "synced" };

const b64 = (b: B) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const end = <T,>(v: T | typeof OPEN_END, f: (x: T) => unknown) => (v === OPEN_END ? null : f(v as T));

export function encodeRange(r: Range3d<B>): unknown {
  return {
    s: [toHex(r.subspaceRange.start), end(r.subspaceRange.end, toHex)],
    p: [r.pathRange.start.map(toHex), end(r.pathRange.end, (p: B[]) => p.map(toHex))],
    t: [r.timeRange.start.toString(), end(r.timeRange.end, (x: bigint) => x.toString())],
  };
}

export function decodeRange(j: unknown): Range3d<B> {
  const o = j as { s: [string, string | null]; p: [string[], string[] | null]; t: [string, string | null] };
  return {
    subspaceRange: { start: fromHex(o.s[0]), end: o.s[1] === null ? OPEN_END : fromHex(o.s[1]) },
    pathRange: { start: o.p[0].map(fromHex), end: o.p[1] === null ? OPEN_END : o.p[1].map(fromHex) },
    timeRange: { start: BigInt(o.t[0]), end: o.t[1] === null ? OPEN_END : BigInt(o.t[1]) },
  };
}

export function encodeEntry(e: WireEntry): unknown {
  const x = e.entry;
  return {
    s: toHex(x.subspaceId), p: x.path.map(toHex), ts: x.timestamp.toString(), n: x.payloadLength.toString(),
    d: toHex(x.payloadDigest), tok: toHex(e.token), pl: e.payload ? b64(e.payload) : undefined,
  };
}

export function decodeEntry(j: unknown, namespace: B): WireEntry {
  const o = j as { s: string; p: string[]; ts: string; n: string; d: string; tok: string; pl?: string };
  return {
    entry: { namespaceId: namespace, subspaceId: fromHex(o.s), path: o.p.map(fromHex), timestamp: BigInt(o.ts), payloadLength: BigInt(o.n), payloadDigest: fromHex(o.d) },
    token: fromHex(o.tok),
    payload: o.pl === undefined ? undefined : unb64(o.pl),
  };
}
