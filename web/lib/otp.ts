// Email OTP lifecycle (issue + verify). Logic adapted for aindrive's
// better-sqlite3 stack from the proven a2a-slack-notion pattern: 6-digit codes,
// hashed at rest (sha256(`${salt}:${code}`)), short expiry, capped attempts,
// timing-safe compare, prior codes invalidated on re-issue.
//
// The code is emailed (lib/email); only its hash is stored, so a DB read never
// yields a usable code. Scope today is "reset_password"; the `purpose` column
// partitions lineages so more flows (signup verification, email link) can share
// the table later without cross-invalidation.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { nanoid } from "nanoid";
import { db } from "./db";

export type OtpPurpose = "reset_password";

export const OTP_EXPIRES_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;

export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function hashOtpCode(code: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

export function isValidOtpFormat(code: string): boolean {
  return /^\d{6}$/.test(code);
}

type CodeRow = {
  id: string;
  code_hash: string;
  salt: string;
  attempts: number;
};

/**
 * Issue a fresh OTP for (email, purpose): invalidate any prior unconsumed codes
 * of the SAME purpose, insert a new one, and return the plaintext code for the
 * caller to email. Only the hash is persisted.
 */
export function issueOtpCode(email: string, purpose: OtpPurpose): string {
  const lower = email.toLowerCase();
  const code = generateOtpCode();
  const salt = randomBytes(16).toString("hex");
  const now = Date.now();

  db.prepare(
    "UPDATE email_verification_codes SET consumed = 1 WHERE email = ? AND purpose = ? AND consumed = 0",
  ).run(lower, purpose);
  db.prepare(
    `INSERT INTO email_verification_codes (id, email, purpose, code_hash, salt, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(nanoid(12), lower, purpose, hashOtpCode(code, salt), salt, now + OTP_EXPIRES_MINUTES * 60_000, now);
  return code;
}

export type OtpVerifyResult =
  | { ok: true }
  | { ok: false; reason: "no_active_code" | "too_many_attempts" | "invalid_code"; remainingAttempts?: number };

/**
 * Verify a presented code against the most recent active row for (email,
 * purpose). Success consumes the row. Wrong codes increment attempts; once the
 * cap is hit the row is burned so it can't be brute-forced further.
 */
export function verifyOtpCode(email: string, code: string, purpose: OtpPurpose): OtpVerifyResult {
  const lower = email.toLowerCase();
  const row = db.prepare(
    `SELECT id, code_hash, salt, attempts FROM email_verification_codes
     WHERE email = ? AND purpose = ? AND consumed = 0 AND expires_at > ?
     ORDER BY created_at DESC LIMIT 1`,
  ).get(lower, purpose, Date.now()) as CodeRow | undefined;

  if (!row) return { ok: false, reason: "no_active_code" };

  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    db.prepare("UPDATE email_verification_codes SET consumed = 1 WHERE id = ?").run(row.id);
    return { ok: false, reason: "too_many_attempts" };
  }

  const expected = Buffer.from(hashOtpCode(code, row.salt), "hex");
  const actual = Buffer.from(row.code_hash, "hex");
  const match = expected.length === actual.length && timingSafeEqual(expected, actual);

  if (!match) {
    db.prepare("UPDATE email_verification_codes SET attempts = attempts + 1 WHERE id = ?").run(row.id);
    return { ok: false, reason: "invalid_code", remainingAttempts: OTP_MAX_ATTEMPTS - (row.attempts + 1) };
  }

  db.prepare("UPDATE email_verification_codes SET consumed = 1, verified_at = ? WHERE id = ?").run(Date.now(), row.id);
  return { ok: true };
}
