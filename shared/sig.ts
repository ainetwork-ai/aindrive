import { createHmac, timingSafeEqual } from "node:crypto";

export function signPayload(secret: string, payload: unknown): string {
  const canonical = JSON.stringify(payload, Object.keys(payload as object).sort());
  return createHmac("sha256", secret).update(canonical).digest("base64url");
}

export function verifyPayload(secret: string, payload: unknown, sig: string): boolean {
  const expected = signPayload(secret, payload);
  if (expected.length !== sig.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}

export function stripSig<T extends { sig: string }>(obj: T): Omit<T, "sig"> {
  const { sig: _sig, ...rest } = obj;
  return rest;
}
