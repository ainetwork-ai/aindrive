/**
 * Google sign-in.
 *   GET  → { clientId } — the OAuth (web) client the app asks Google for an ID token for; 404 when not configured.
 *   POST { idToken } → verifies it (lib/google-auth) and signs in: sets the session cookie and returns
 *        { token, user } so a native app (mobile/) can keep the session like the CLI device-link does.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { sign, setCookie } from "@/lib/session";
import { tryConsume, clientKey } from "@/lib/rate-limit";
import { googleClientIds, verifyGoogleIdToken, resolveAccountForGoogle, GoogleEmailInUseError } from "@/lib/google-auth";
import { adoptSignInPayoutWallet } from "@/lib/drives";
import { legacyLoginRefusal } from "@/lib/sso/policy";
import { attestLegacyLogin } from "@/lib/sso/app-attest";

const Body = z.object({ idToken: z.string().min(20).max(8192) });

export function GET() {
  const [clientId] = googleClientIds();
  if (!clientId) return NextResponse.json({ error: "google_not_configured" }, { status: 404 });
  return NextResponse.json({ clientId }, { headers: { "Cache-Control": "public, max-age=300" } });
}

export async function POST(req: Request) {
  const rl = tryConsume({ name: "auth-google", key: clientKey(req, "auth-google"), limit: 20, windowMs: 60_000 });
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } });
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  let identity;
  try { identity = await verifyGoogleIdToken(body.data.idToken); }
  catch (e) {
    const msg = (e as Error).message;
    if (msg === "google_not_configured") return NextResponse.json({ error: msg }, { status: 404 });
    return NextResponse.json({ error: msg === "email_not_verified" || msg === "no_email" ? msg : "invalid token" }, { status: 401 });
  }
  // Direct Google sign-in is a legacy method once AIN SSO is on (lib/sso/policy).
  const off = legacyLoginRefusal(null);
  if (off) return NextResponse.json({ error: off.error }, { status: off.status });
  let resolved;
  try { resolved = resolveAccountForGoogle(identity); }
  catch (e) {
    if (e instanceof GoogleEmailInUseError) return NextResponse.json({ error: "email_in_use" }, { status: 409 });
    throw e;
  }
  const { id, created } = resolved;
  const refusal = legacyLoginRefusal(id);
  if (refusal) return NextResponse.json({ error: refusal.error }, { status: refusal.status });
  const user = db.prepare("SELECT id, email, name FROM users WHERE id = ?").get(id) as { id: string; email: string; name: string };
  adoptSignInPayoutWallet(id);
  await setCookie(id);
  // Best effort, not awaited: the verified Google sub links the account to
  // the AIN account with that Google identity (lib/sso/app-attest.ts).
  void attestLegacyLogin({ userId: id, method: "google", googleSub: identity.sub });
  return NextResponse.json({ token: await sign(id), user, created });
}
