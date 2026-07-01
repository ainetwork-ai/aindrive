// HMAC sign/verify of the RPC frames exchanged between the web server and this
// agent — the server can't act on the filesystem without a signature made from
// the per-drive secret.
//
// MUST stay byte-for-byte compatible with web/lib/sig.js (the canonical copy):
// the same secret has to produce the same signature on both sides. That
// cross-package compatibility is machine-checked by sig.test.mjs, which imports
// web/lib/sig.js directly and round-trips against it.
//
// Gotcha (locked by sig.test.mjs): signPayload canonicalises with
// JSON.stringify(payload, sortedTopLevelKeys) — the 2nd arg is a key allowlist,
// NOT a recursive sorter, so nested object keys serialise in insertion order.
// Both sides must emit nested keys in the same order for a signature to match;
// keep signed RPC payloads flat.
import { createHmac, timingSafeEqual } from "node:crypto";

export function signPayload(secret, payload) {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return createHmac("sha256", secret).update(canonical).digest("base64url");
}

export function verifyPayload(secret, payload, sig) {
  const expected = signPayload(secret, payload);
  if (expected.length !== sig.length) return false;
  try { return timingSafeEqual(Buffer.from(expected), Buffer.from(sig)); }
  catch { return false; }
}

export function stripSig(obj) {
  const { sig, ...rest } = obj;
  return rest;
}
