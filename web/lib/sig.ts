import { createHmac, timingSafeEqual } from "node:crypto";

export function signPayload<T extends object>(secret: string, payload: T): string {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return createHmac("sha256", secret).update(canonical).digest("base64url");
}

export function verifyPayload<T extends object>(secret: string, payload: T, sig: string): boolean {
  const expected = signPayload(secret, payload);
  if (expected.length !== sig.length) return false;
  try { return timingSafeEqual(Buffer.from(expected), Buffer.from(sig)); }
  catch { return false; }
}
