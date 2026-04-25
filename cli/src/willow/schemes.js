/**
 * Willow parameter schemes for the aindrive CLI agent.
 *
 * Mirrors web/lib/willow/schemes.js but uses a lightweight no-op
 * authorisation scheme: since the CLI store is local-only for now,
 * every write is authorised and the auth-token is an empty Uint8Array.
 * Real Meadowcap cap-checking will be layered on during WGPS wiring.
 *
 * NamespaceId  = Uint8Array(32)   — Ed25519 pubkey or synthetic 32-byte root key
 * SubspaceId   = string           — docId string (avoids Ed25519 overhead for local use)
 * PayloadDigest = Uint8Array(32)  — SHA-256
 * AuthorisationToken = Uint8Array(0)  — no-op
 */

import { createHash } from "node:crypto";

// ─── Namespace scheme ────────────────────────────────────────────────────────
// NamespaceId is a 32-byte Uint8Array (Ed25519 pubkey or synthetic).
export const namespaceScheme = {
  encode(nsId) { return nsId; },
  decode(bytes) { return bytes.slice(0, 32); },
  encodedLength() { return 32; },
  async decodeStream(bytes) {
    await bytes.nextAbsolute(32);
    const out = bytes.array.slice(0, 32);
    bytes.prune(32);
    return out;
  },
  isEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  },
  defaultNamespaceId: new Uint8Array(32),
};

// ─── Subspace scheme ─────────────────────────────────────────────────────────
// SubspaceId is a string (the docId), encoded as a fixed-width 64-byte
// null-padded ASCII field. Fixed width is required so that decodeEntry() can
// correctly advance past the subspace field using encodedLength() alone —
// decodeEntry() calls `decode(bigSlice)` then `encodedLength(result)` to skip
// forward, so the byte count must be deterministic regardless of content.
// docIds are validated by rpc.js to match /^[A-Za-z0-9_-]{8,64}$/ so 64 bytes is sufficient.
const SUBSPACE_BYTES = 64;

export const subspaceScheme = {
  encode(docId) {
    const utf8 = new TextEncoder().encode(docId);
    const buf = new Uint8Array(SUBSPACE_BYTES); // zero-filled = null-padded
    buf.set(utf8.slice(0, SUBSPACE_BYTES));
    return buf;
  },
  decode(bytes) {
    // Read exactly SUBSPACE_BYTES, strip trailing null bytes.
    const slice = bytes.slice(0, SUBSPACE_BYTES);
    let end = slice.length;
    while (end > 0 && slice[end - 1] === 0) end--;
    return new TextDecoder().decode(slice.slice(0, end));
  },
  encodedLength(_docId) { return SUBSPACE_BYTES; },
  async decodeStream(bytes) {
    await bytes.nextAbsolute(SUBSPACE_BYTES);
    const slice = bytes.array.slice(0, SUBSPACE_BYTES);
    bytes.prune(SUBSPACE_BYTES);
    let end = slice.length;
    while (end > 0 && slice[end - 1] === 0) end--;
    return new TextDecoder().decode(slice.slice(0, end));
  },
  // Total ordering on strings (lexicographic, which matches the zero-padded bytes)
  order(a, b) {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  },
  successor(docId) {
    // Append '\x01' (first non-null char) to get the next ordered docId.
    return docId + "\x01";
  },
  minimalSubspaceId: "",
};

// ─── Payload (digest) scheme ──────────────────────────────────────────────────
// PayloadDigest is a SHA-256 Uint8Array(32).
export const payloadScheme = {
  encode(digest) { return digest; },
  decode(bytes) { return bytes.slice(0, 32); },
  encodedLength() { return 32; },
  async decodeStream(bytes) {
    await bytes.nextAbsolute(32);
    const out = bytes.array.slice(0, 32);
    bytes.prune(32);
    return out;
  },
  async fromBytes(bytes) {
    const data = bytes instanceof Uint8Array
      ? bytes
      : new Uint8Array(await collectUint8Arrays(bytes));
    return new Uint8Array(createHash("sha256").update(data).digest());
  },
  order(a, b) {
    for (let i = 0; i < 32; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    return 0;
  },
  defaultDigest: new Uint8Array(32),
};

async function collectUint8Arrays(iter) {
  const chunks = [];
  for await (const chunk of iter) chunks.push(chunk);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// ─── Path scheme ──────────────────────────────────────────────────────────────
export const pathScheme = {
  maxComponentCount: 16,
  maxComponentLength: 256,
  maxPathLength: 4096,
};

// ─── Authorisation scheme (no-op local) ──────────────────────────────────────
// For local-only use: every write is authorised, token = empty Uint8Array.
const EMPTY_TOKEN = new Uint8Array(0);

export const authorisationScheme = {
  async authorise(_entry, _opts) {
    return EMPTY_TOKEN;
  },
  async isAuthorisedWrite(_entry, _token) {
    return true;
  },
  tokenEncoding: {
    encode(_token) { return new Uint8Array(0); },
    decode(_bytes) { return EMPTY_TOKEN; },
    encodedLength() { return 0; },
    async decodeStream(bytes) { return EMPTY_TOKEN; },
  },
};

// ─── Fingerprint scheme (simple XOR over SHA-256 digests) ────────────────────
// Used for 3D range-based set reconciliation during WGPS sync.
// Pre-fingerprint = Uint8Array(32), Fingerprint = Uint8Array(32).
export const fingerprintScheme = {
  async fingerprintSingleton({ entry }) {
    const pre = new Uint8Array(32);
    const d = entry.payloadDigest;
    for (let i = 0; i < 32; i++) pre[i] = d[i] ^ 0;
    return pre;
  },
  fingerprintCombine(a, b) {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = a[i] ^ b[i];
    return out;
  },
  async fingerprintFinalise(pre) { return pre; },
  neutral: new Uint8Array(32),
  neutralFinalised: new Uint8Array(32),
  isEqual(a, b) {
    for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return false;
    return true;
  },
  encoding: {
    encode(fp) { return fp; },
    decode(bytes) { return bytes.slice(0, 32); },
    encodedLength() { return 32; },
    async decodeStream(bytes) {
      await bytes.nextAbsolute(32);
      const out = bytes.array.slice(0, 32);
      bytes.prune(32);
      return out;
    },
  },
};

// ─── Combined store schemes ───────────────────────────────────────────────────
export const storeSchemes = {
  path: pathScheme,
  namespace: namespaceScheme,
  subspace: subspaceScheme,
  payload: payloadScheme,
  authorisation: authorisationScheme,
  fingerprint: fingerprintScheme,
};
