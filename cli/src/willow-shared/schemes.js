// GENERATED from web/shared/willow/schemes.ts by web/scripts/mirror-willow-to-cli.mjs — do not edit.
import { sha256 } from "@noble/hashes/sha2.js";
import { encodeEntry } from "@jsr/earthstar__willow-utils";
import { Store } from "@earthstar/willow";
import { equalBytes, utf8 } from "./bytes.js";
import { sign, verify } from "./keys.js";
const fixed32 = {
  encode: (b) => b,
  decode: (b) => b.slice(0, 32),
  encodedLength: (_value) => 32,
  async decodeStream(bytes) {
    await bytes.nextAbsolute(32);
    const out = bytes.array.slice(0, 32);
    bytes.prune(32);
    return out;
  }
};
const order = (a, b) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
};
function successor32(b) {
  const out = b.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] < 255) {
      out[i]++;
      return out;
    }
    out[i] = 0;
  }
  return null;
}
async function collect(p) {
  if (p instanceof Uint8Array) return p;
  const parts = [];
  for await (const c of p) parts.push(c);
  const out = new Uint8Array(parts.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of parts) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
const pathScheme = { maxComponentCount: 32, maxComponentLength: 512, maxPathLength: 8192 };
function encodeEntryBytes(entry) {
  return encodeEntry({ encodeNamespace: (n) => n, encodeSubspace: (s) => s, encodePayload: (d) => d, pathScheme }, entry);
}
const SIG_LEN = 64;
const aindriveSchemes = {
  path: pathScheme,
  namespace: { ...fixed32, isEqual: equalBytes, defaultNamespaceId: new Uint8Array(32) },
  subspace: { ...fixed32, order, successor: successor32, minimalSubspaceId: new Uint8Array(32) },
  payload: {
    ...fixed32,
    fromBytes: async (b) => sha256(await collect(b)),
    order,
    defaultDigest: new Uint8Array(32)
  },
  authorisation: {
    // Signs with whatever key it is given; a key that does not own the subspace
    // produces a token isAuthorisedWrite refuses, so the store reports failure.
    authorise: (entry, kp) => sign(kp, encodeEntryBytes(entry)),
    isAuthorisedWrite: (entry, token) => token.length === SIG_LEN ? verify(entry.subspaceId, encodeEntryBytes(entry), token) : Promise.resolve(false),
    tokenEncoding: {
      encode: (t) => t,
      decode: (b) => b.slice(0, SIG_LEN),
      encodedLength: () => SIG_LEN,
      async decodeStream(bytes) {
        await bytes.nextAbsolute(SIG_LEN);
        const out = bytes.array.slice(0, SIG_LEN);
        bytes.prune(SIG_LEN);
        return out;
      }
    }
  },
  fingerprint: {
    // XOR of SHA-256(encoded entry): associative, commutative, neutral = zeros.
    fingerprintSingleton: async ({ entry }) => sha256(encodeEntryBytes(entry)),
    fingerprintCombine: (a, b) => a.map((x, i) => x ^ b[i]),
    fingerprintFinalise: async (a) => a,
    neutral: new Uint8Array(32),
    neutralFinalised: new Uint8Array(32),
    isEqual: equalBytes,
    encoding: fixed32
  }
};
const namespaceOf = (driveId) => sha256(utf8(`aindrive/namespace/v1/${driveId}`));
const nowMicros = () => BigInt(Date.now()) * 1000n;
function newStore(driveId) {
  return new Store({ namespace: namespaceOf(driveId), schemes: aindriveSchemes });
}
export {
  aindriveSchemes,
  encodeEntryBytes,
  namespaceOf,
  newStore,
  nowMicros
};
