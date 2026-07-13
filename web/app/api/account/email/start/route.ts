import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getUser } from "@/lib/session";
import { issueOtpCode, OTP_EXPIRES_MINUTES } from "@/lib/otp";
import { sendMail, mailConfigured } from "@/lib/email";
import { renderOtpEmail } from "@/lib/email/templates/otp-code";
import { isWalletOnlyEmail } from "@/shared/wallet-display";
import { tryConsume, clientKey } from "@/lib/rate-limit";

const Body = z.object({ email: z.string().email() });

// Step 1 of attaching a real email to a wallet-only account: prove the caller
// IS a wallet-only account, the target email is free, then issue + send an OTP.
export async function POST(req: Request) {
  const rl = tryConsume({ name: "attach-email-start", key: clientKey(req, "attach-email-start"), limit: 5, windowMs: 60_000 });
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } });

  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isWalletOnlyEmail(user.email)) return NextResponse.json({ error: "not_wallet_only" }, { status: 403 });

  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid email" }, { status: 400 });
  const email = body.data.email.toLowerCase();
  if (isWalletOnlyEmail(email)) return NextResponse.json({ error: "reserved domain" }, { status: 400 });

  const taken = db.prepare("SELECT 1 FROM users WHERE lower(email) = lower(?)").get(email);
  if (taken) return NextResponse.json({ error: "email_taken" }, { status: 409 });

  const code = issueOtpCode(email, "attach_email");
  if (mailConfigured()) {
    const mail = renderOtpEmail({ code, expiresInMinutes: OTP_EXPIRES_MINUTES, kind: "attach" });
    await sendMail({ to: email, subject: mail.subject, html: mail.html, text: mail.text });
  }
  return NextResponse.json({ ok: true });
}
