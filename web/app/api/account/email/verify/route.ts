import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { getUser } from "@/lib/session";
import { verifyOtpCode } from "@/lib/otp";
import { isWalletOnlyEmail } from "@/shared/wallet-display";
import { tryConsume, clientKey } from "@/lib/rate-limit";

const Body = z.object({
  email: z.string().email(),
  code: z.string().min(4),
  password: z.string().min(8),
});

// Step 2: verify the OTP, then attach the email + a real password to the
// wallet-only account. The wallet credential stays; this only ADDS an email
// login (never wallet-key recovery). Guarded so a real account can't reroute
// its email through this path.
export async function POST(req: Request) {
  const rl = tryConsume({ name: "attach-email-verify", key: clientKey(req, "attach-email-verify"), limit: 10, windowMs: 60_000 });
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } });

  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isWalletOnlyEmail(user.email)) return NextResponse.json({ error: "not_wallet_only" }, { status: 403 });

  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const email = body.data.email.toLowerCase();
  if (isWalletOnlyEmail(email)) return NextResponse.json({ error: "reserved domain" }, { status: 400 });

  const verdict = verifyOtpCode(email, body.data.code, "attach_email");
  if (!verdict.ok) return NextResponse.json({ error: "bad_code", reason: verdict.reason }, { status: 422 });

  const hash = bcrypt.hashSync(body.data.password, 10);
  try {
    db.prepare("UPDATE users SET email = ?, password_hash = ? WHERE id = ?").run(email, hash, user.id);
  } catch (e) {
    // email UNIQUE lost a race between start's check and here.
    if (/UNIQUE/i.test((e as Error).message)) return NextResponse.json({ error: "email_taken" }, { status: 409 });
    throw e;
  }
  return NextResponse.json({ ok: true });
}
