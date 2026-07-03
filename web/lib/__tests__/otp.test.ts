import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-otp-"));

const { db } = await import("../db.js");
const { issueOtpCode, verifyOtpCode, hashOtpCode, generateOtpCode, isValidOtpFormat, OTP_MAX_ATTEMPTS, OTP_EXPIRES_MINUTES } =
  await import("../otp.js");

const EMAIL = "user@example.com";

beforeEach(() => db.prepare("DELETE FROM email_verification_codes").run());
afterEach(() => vi.useRealTimers());

describe("otp primitives", () => {
  it("generates a 6-digit code and validates format", () => {
    for (let i = 0; i < 50; i++) expect(isValidOtpFormat(generateOtpCode())).toBe(true);
    expect(isValidOtpFormat("12345")).toBe(false);
    expect(isValidOtpFormat("abcdef")).toBe(false);
  });
  it("hash is salted (same code, different salt → different hash) and stored, not the code", () => {
    expect(hashOtpCode("123456", "s1")).not.toBe(hashOtpCode("123456", "s2"));
    const code = issueOtpCode(EMAIL, "reset_password");
    const row = db.prepare("SELECT code_hash FROM email_verification_codes WHERE email = ?").get(EMAIL) as { code_hash: string };
    expect(row.code_hash).not.toContain(code); // plaintext never persisted
  });
});

describe("verifyOtpCode", () => {
  it("accepts the correct code once, then the row is consumed (no replay)", () => {
    const code = issueOtpCode(EMAIL, "reset_password");
    expect(verifyOtpCode(EMAIL, code, "reset_password")).toEqual({ ok: true });
    expect(verifyOtpCode(EMAIL, code, "reset_password")).toMatchObject({ ok: false, reason: "no_active_code" });
  });

  it("is case-insensitive on email", () => {
    const code = issueOtpCode("MixedCase@Example.com", "reset_password");
    expect(verifyOtpCode("mixedcase@example.com", code, "reset_password")).toEqual({ ok: true });
  });

  it("rejects a wrong code, counts down attempts, and burns the row at the cap", () => {
    issueOtpCode(EMAIL, "reset_password");
    for (let i = 1; i <= OTP_MAX_ATTEMPTS; i++) {
      const r = verifyOtpCode(EMAIL, "000000", "reset_password"); // assume wrong (1e-6 chance of collision)
      expect(r.ok).toBe(false);
    }
    // next attempt: row is at cap → burned
    expect(verifyOtpCode(EMAIL, "000000", "reset_password")).toMatchObject({ ok: false, reason: "too_many_attempts" });
  });

  it("returns no_active_code for an email that never requested one", () => {
    expect(verifyOtpCode("nobody@example.com", "123456", "reset_password")).toMatchObject({ ok: false, reason: "no_active_code" });
  });

  it("rejects an expired code", () => {
    const code = issueOtpCode(EMAIL, "reset_password");
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + (OTP_EXPIRES_MINUTES + 1) * 60_000);
    expect(verifyOtpCode(EMAIL, code, "reset_password")).toMatchObject({ ok: false, reason: "no_active_code" });
  });

  it("re-issuing invalidates the previous code (only the latest works)", () => {
    const first = issueOtpCode(EMAIL, "reset_password");
    const second = issueOtpCode(EMAIL, "reset_password");
    expect(verifyOtpCode(EMAIL, first, "reset_password")).toMatchObject({ ok: false });
    expect(verifyOtpCode(EMAIL, second, "reset_password")).toEqual({ ok: true });
  });
});
