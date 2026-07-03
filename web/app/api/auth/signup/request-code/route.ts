import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { issueOtpCode, OTP_EXPIRES_MINUTES } from "@/lib/otp";
import { sendMail } from "@/lib/email";
import { renderOtpEmail } from "@/lib/email/templates/otp-code";
import { tryConsume, clientKey } from "@/lib/rate-limit";

const Body = z.object({
  email: z.string().email().refine(
    (v) => !v.toLowerCase().endsWith("@wallet.aindrive.local"),
    "reserved address",
  ),
});

// Step 1 of verify-before-create signup: email a 6-digit code proving the
// visitor controls the inbox. If the email is already registered we don't send
// a signup code — we tell the client to log in instead (signup already reveals
// existence via 409, so this isn't new enumeration). Rate-limited per IP+email.
export async function POST(req: Request) {
  const ipRl = tryConsume({ name: "signup-code-ip", key: clientKey(req, "signup-code"), limit: 5, windowMs: 300_000 });
  if (!ipRl.ok) {
    const retryAfter = Math.ceil(ipRl.retryAfterMs / 1000);
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(retryAfter) } });
  }
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const email = body.data.email;

  const exists = db.prepare("SELECT id FROM users WHERE lower(email) = lower(?)").get(email);
  if (exists) return NextResponse.json({ ok: true, alreadyRegistered: true });

  const emailRl = tryConsume({ name: "signup-code-email", key: email.toLowerCase(), limit: 3, windowMs: 300_000 });
  if (emailRl.ok) {
    try {
      const code = issueOtpCode(email, "signup");
      const mail = renderOtpEmail({ code, expiresInMinutes: OTP_EXPIRES_MINUTES, kind: "signup" });
      await sendMail({ to: email, subject: mail.subject, html: mail.html, text: mail.text });
    } catch (e) {
      console.error("[signup-code] send failed:", (e as Error).message);
    }
  }
  return NextResponse.json({ ok: true });
}
