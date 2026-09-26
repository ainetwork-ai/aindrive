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
import { googleClientIds, verifyGoogleIdToken, resolveAccountForGoogle } from "@/lib/google-auth";

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
  const { id, created } = resolveAccountForGoogle(identity);
  const user = db.prepare("SELECT id, email, name FROM users WHERE id = ?").get(id) as { id: string; email: string; name: string };
  await setCookie(id);
  return NextResponse.json({ token: await sign(id), user, created });
}
