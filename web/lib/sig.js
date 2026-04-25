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
