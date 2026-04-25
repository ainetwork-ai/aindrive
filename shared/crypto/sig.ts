/**
 * HMAC-SHA256 payload signing — single source of truth.
 *
 * This is the canonical implementation. Existing duplicates at
 *   - shared/sig.ts
 *   - web/lib/sig.ts
 *   - web/lib/sig.js
 *   - cli/src/sig.js
 * should be migrated to import from here. Do NOT add new sig files.
 *
 * Why a fixed payload encoding: signing JSON.stringify with arbitrary key
 * order would let two equivalent payloads produce different signatures
 * (and thus mismatch on verify). We canonicalize by sorting keys.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function signPayload<T extends object>(secret: string, payload: T): string {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return createHmac("sha256", secret).update(canonical).digest("base64url");
}

export function verifyPayload<T extends object>(secret: string, payload: T, sig: string): boolean {
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
