import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { issueOtpCode, OTP_EXPIRES_MINUTES } from "@/lib/otp";
import { sendMail } from "@/lib/email";
import { renderResetOtpEmail } from "@/lib/email/templates/reset-otp";
import { tryConsume, clientKey } from "@/lib/rate-limit";

const Body = z.object({ email: z.string().email() });

// Request a password-reset code. ALWAYS returns 200 with the same body whether
// or not the email is registered — an attacker must not be able to probe which
// addresses have accounts (enumeration). Rate-limited per IP and per email so
// the mailbox isn't flooded and the sender reputation isn't burned.
export async function POST(req: Request) {
  const ipRl = tryConsume({ name: "forgot-pw-ip", key: clientKey(req, "forgot-pw"), limit: 5, windowMs: 300_000 });
  if (!ipRl.ok) {
    return NextResponse.json({ ok: true }, { status: 200 }); // stay quiet even when throttled
  }
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const email = body.data.email;

  const emailRl = tryConsume({ name: "forgot-pw-email", key: email.toLowerCase(), limit: 3, windowMs: 300_000 });
  const user = db.prepare("SELECT id FROM users WHERE lower(email) = lower(?)").get(email) as { id: string } | undefined;

  // Only issue + send when the account exists AND this email isn't over its own
  // rate limit. Either way the response is identical (anti-enumeration).
  if (user && emailRl.ok) {
    try {
      const code = issueOtpCode(email, "reset_password");
      const mail = renderResetOtpEmail({ code, expiresInMinutes: OTP_EXPIRES_MINUTES });
      await sendMail({ to: email, subject: mail.subject, html: mail.html, text: mail.text });
    } catch (e) {
      // Don't leak delivery failure to the caller (still 200), but log it —
      // a misconfigured SMTP shouldn't silently swallow reset requests.
      console.error("[forgot-password] send failed:", (e as Error).message);
    }
  }
  return NextResponse.json({ ok: true });
}
