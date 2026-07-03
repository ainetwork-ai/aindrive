import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "@/lib/db";
import { setCookie } from "@/lib/session";
import { claimInvitesForEmail } from "@/lib/invites.js";
import { verifyOtpCode } from "@/lib/otp";
import { tryConsume, clientKey } from "@/lib/rate-limit";

const Body = z.object({
  // Reject the reserved wallet-placeholder domain (resolveAccountForWallet
  // mints <wallet>@wallet.aindrive.local) so an attacker can't pre-register a
  // victim wallet's account through human signup.
  email: z.string().email().refine(
    (v) => !v.toLowerCase().endsWith("@wallet.aindrive.local"),
    "reserved address",
  ),
  // Verify-before-create: the 6-digit code emailed by /signup/request-code
  // proves the visitor controls this inbox, so every account has a real email.
  code: z.string().regex(/^\d{6}$/),
  name: z.string().min(1).max(80),
  password: z.string().min(8).max(200),
});

export async function POST(req: Request) {
  const rl = tryConsume({ name: "auth-signup", key: clientKey(req, "auth-signup"), limit: 5, windowMs: 300_000 });
  if (!rl.ok) {
    const retryAfter = Math.ceil(rl.retryAfterMs / 1000);
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(retryAfter) } });
  }
  const body = Body.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const { email, code, name, password } = body.data;

  // Consume the emailed signup code before creating anything. A bad/expired
  // code stops here — no account, no session.
  const verdict = verifyOtpCode(email, code, "signup");
  if (!verdict.ok) {
    return NextResponse.json(
      { error: verdict.reason, remainingAttempts: verdict.remainingAttempts },
      { status: 400 },
    );
  }

  const exists = db.prepare("SELECT id FROM users WHERE lower(email) = lower(?)").get(email);
  if (exists) return NextResponse.json({ error: "email already registered" }, { status: 409 });

  const isFirst = (db.prepare("SELECT count(*) as c FROM users").get() as { c: number }).c === 0;
  const id = nanoid(10);
  const hash = await bcrypt.hash(password, 10);
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)"
  ).run(id, email, name, hash, isFirst ? "admin" : "member");
  // Turn any invites addressed to this email into real grants so the drives
  // they were invited to show up immediately after signup.
  claimInvitesForEmail(id, email);
  await setCookie(id);
  return NextResponse.json({ ok: true });
}
