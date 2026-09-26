// web/shared/willow/schemes.ts
// Willow parameters for aindrive (spec §3 D1/D2): communal namespace per drive,
// subspace = device key (Ed25519, 32 B), payload digest = SHA-256, and the
// communal-namespace write rule: the token is the subspace owner's signature
// over the encoded entry. Membership (who may write where) is policy.ts, applied
// by peers at ingest (D4); this file is only "is it really from that device".
import { sha256 } from "@noble/hashes/sha2.js";
import { encodeEntry, type Entry, type GrowingBytes } from "@earthstar/willow-utils";
import { Store } from "@earthstar/willow";
import { equalBytes, utf8 } from "./bytes";
import { sign, verify, type DeviceKeypair } from "./keys";

type Bytes = Uint8Array;

const fixed32 = {
  encode: (b: Bytes) => b,
  decode: (b: Bytes) => b.slice(0, 32),
  encodedLength: (_value?: Bytes) => 32,
  async decodeStream(bytes: GrowingBytes) {
    await bytes.nextAbsolute(32);
    const out = bytes.array.slice(0, 32);
    bytes.prune(32);
    return out;
  },
};

const order = (a: Bytes, b: Bytes): -1 | 0 | 1 => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
};

function successor32(b: Bytes): Bytes | null {
  const out = b.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] < 255) { out[i]++; return out; }
    out[i] = 0;
  }
  return null;
}

async function collect(p: Bytes | AsyncIterable<Bytes>): Promise<Bytes> {
  if (p instanceof Uint8Array) return p;
  const parts: Bytes[] = [];
  for await (const c of p) parts.push(c);
  const out = new Uint8Array(parts.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of parts) { out.set(c, off); off += c.length; }
  return out;
}

const pathScheme = { maxComponentCount: 32, maxComponentLength: 512, maxPathLength: 8192 };

export function encodeEntryBytes(entry: Entry<Bytes, Bytes, Bytes>): Bytes {
  return encodeEntry({ encodeNamespace: (n) => n, encodeSubspace: (s) => s, encodePayload: (d) => d, pathScheme }, entry);
}

const SIG_LEN = 64;

export const aindriveSchemes = {
  path: pathScheme,
  namespace: { ...fixed32, isEqual: equalBytes, defaultNamespaceId: new Uint8Array(32) },
  subspace: { ...fixed32, order, successor: successor32, minimalSubspaceId: new Uint8Array(32) },
  payload: {
    ...fixed32,
    fromBytes: async (b: Bytes | AsyncIterable<Bytes>) => sha256(await collect(b)),
    order,
    defaultDigest: new Uint8Array(32),
  },
  authorisation: {
    // Signs with whatever key it is given; a key that does not own the subspace
    // produces a token isAuthorisedWrite refuses, so the store reports failure.
    authorise: (entry: Entry<Bytes, Bytes, Bytes>, kp: DeviceKeypair) => sign(kp, encodeEntryBytes(entry)),
    isAuthorisedWrite: (entry: Entry<Bytes, Bytes, Bytes>, token: Bytes) =>
      token.length === SIG_LEN ? verify(entry.subspaceId, encodeEntryBytes(entry), token) : Promise.resolve(false),
    tokenEncoding: {
      encode: (t: Bytes) => t,
      decode: (b: Bytes) => b.slice(0, SIG_LEN),
      encodedLength: () => SIG_LEN,
      async decodeStream(bytes: GrowingBytes) {
        await bytes.nextAbsolute(SIG_LEN);
        const out = bytes.array.slice(0, SIG_LEN);
        bytes.prune(SIG_LEN);
        return out;
      },
    },
  },
  fingerprint: {
    // XOR of SHA-256(encoded entry): associative, commutative, neutral = zeros.
    fingerprintSingleton: async ({ entry }: { entry: Entry<Bytes, Bytes, Bytes> }) => sha256(encodeEntryBytes(entry)),
    fingerprintCombine: (a: Bytes, b: Bytes) => a.map((x, i) => x ^ b[i]),
    fingerprintFinalise: async (a: Bytes) => a,
    neutral: new Uint8Array(32),
    neutralFinalised: new Uint8Array(32),
    isEqual: equalBytes,
    encoding: fixed32,
  },
};

/** One communal namespace per drive, derived from the drive id: nobody holds a secret for it. */
export const namespaceOf = (driveId: string): Bytes => sha256(utf8(`aindrive/namespace/v1/${driveId}`));

export const nowMicros = (): bigint => BigInt(Date.now()) * 1000n;

/** An in-memory store for `driveId` (tests; Plans 2/3 pass persistent drivers).
 *  The library's default drivers wire the payload length into the entry driver. */
export function newStore(driveId: string) {
  return new Store({ namespace: namespaceOf(driveId), schemes: aindriveSchemes });
}
