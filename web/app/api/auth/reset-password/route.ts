import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/lib/db";
import { verifyOtpCode } from "@/lib/otp";
import { tryConsume, clientKey } from "@/lib/rate-limit";

// Same password rule as signup (min 8).
const Body = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/),
  newPassword: z.string().min(8).max(200),
});

// Complete a reset: verify the emailed OTP, then set the new password. The OTP
// (proof the requester controls the inbox = the account) is the authorization;
// no session needed. Rate-limited so codes can't be brute-forced past the
// per-code attempt cap by cycling requests.
export async function POST(req: Request) {
  const rl = tryConsume({ name: "reset-pw", key: clientKey(req, "reset-pw"), limit: 10, windowMs: 300_000 });
  if (!rl.ok) {
    const retryAfter = Math.ceil(rl.retryAfterMs / 1000);
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(retryAfter) } });
  }
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const { email, code, newPassword } = body.data;

  const verdict = verifyOtpCode(email, code, "reset_password");
  if (!verdict.ok) {
    // Reasons are safe to surface — they don't reveal whether the account
    // exists (a nonexistent email simply never has an active code either).
    return NextResponse.json(
      { error: verdict.reason, remainingAttempts: verdict.remainingAttempts },
      { status: 400 },
    );
  }

  const hash = await bcrypt.hash(newPassword, 10);
  const res = db.prepare("UPDATE users SET password_hash = ? WHERE lower(email) = lower(?)").run(hash, email);
  // The OTP verified against a real account moments ago; a 0-row update would
  // mean the account vanished in between. Treat as a generic failure.
  if (res.changes === 0) return NextResponse.json({ error: "account not found" }, { status: 400 });

  return NextResponse.json({ ok: true });
}
