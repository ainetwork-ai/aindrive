/**
 * POST /api/auth/sso/link — finishes an AIN sign-in whose AIN account is not
 * linked to an aindrive account yet (ADR-0004 `app_proof`). Needs the pending
 * link cookie from the callback and a same-origin request. Body:
 *
 *   { method: "legacy_session" }                     the aindrive account this browser is signed in to
 *   { method: "legacy_password", email, password }   an aindrive email + password
 *   { method: "new" }                                create a new aindrive account
 *
 * A proof links the existing account once (never by email alone; never an
 * account already linked or suspended) and is reported to AIN SSO best effort.
 * Answers { redirect } — where the browser goes next, signed in.
 */
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/lib/db";
import { getUser } from "@/lib/session";
import { isSameOrigin } from "@/lib/oauth";
import { tryConsume, clientKey } from "@/lib/rate-limit";
import { legacyLoginMode, ssoLoginConfig } from "@/lib/sso/config";
import { legacyLoginRefusal } from "@/lib/sso/policy";
import { reportAppProof, type AppProofMethod } from "@/lib/sso/app-proof";
import { deletePendingLink, getPendingLink, isAccountBlocked, linkExistingUser, resolveOrCreateUserForSubject, type PendingLinkRow } from "@/lib/sso/store.js";
import { beginSsoSession, clearLinkCookie, readLinkCookie } from "@/lib/sso/signin";

const Body = z.discriminatedUnion("method", [
  z.object({ method: z.literal("legacy_session") }),
  z.object({ method: z.literal("legacy_password"), email: z.string().email(), password: z.string().min(1).max(200) }),
  z.object({ method: z.literal("new") }),
]);

const LINK_ERRORS: Record<string, number> = {
  sub_already_linked: 409,
  account_already_linked: 409,
  account_suspended: 403,
  user_not_found: 400,
};

async function finish(pending: PendingLinkRow, userId: string) {
  deletePendingLink(pending.id);
  await clearLinkCookie();
  let orgIds: string[] = [];
  try { orgIds = JSON.parse(pending.org_ids); } catch {}
  await beginSsoSession(userId, { issuer: pending.issuer, subject: pending.subject, oidcSid: pending.oidc_sid, orgId: pending.org_id, orgIds });
  return NextResponse.json({ redirect: pending.next_path });
}

export async function POST(req: Request) {
  const config = ssoLoginConfig();
  if (!config) return NextResponse.json({ error: "sso_not_configured" }, { status: 404 });
  if (!isSameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const pending = getPendingLink(await readLinkCookie());
  if (!pending || pending.issuer !== config.issuer) return NextResponse.json({ error: "expired" }, { status: 400 });
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });

  if (body.data.method === "new") {
    const { userId } = resolveOrCreateUserForSubject({
      issuer: pending.issuer,
      subject: pending.subject,
      name: pending.name,
      email: pending.email,
      emailVerified: pending.email_verified === 1,
    });
    if (isAccountBlocked(userId)) return NextResponse.json({ error: "account_suspended" }, { status: 403 });
    return finish(pending, userId);
  }

  // Proving a legacy account is a legacy sign-in: same switches, same suspension rule.
  if (legacyLoginMode() === "false") return NextResponse.json({ error: "legacy_login_disabled" }, { status: 403 });

  let userId: string;
  let method: AppProofMethod;
  if (body.data.method === "legacy_session") {
    const user = await getUser();
    if (!user) return NextResponse.json({ error: "not signed in" }, { status: 401 });
    userId = user.id;
    method = "legacy_session";
  } else {
    const rl = tryConsume({ name: "auth-login", key: clientKey(req, "auth-login"), limit: 10, windowMs: 60_000 });
    if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } });
    const row = db
      .prepare("SELECT id, password_hash FROM users WHERE lower(email) = lower(?)")
      .get(body.data.email) as { id: string; password_hash: string } | undefined;
    if (!row || !(await bcrypt.compare(body.data.password, row.password_hash))) {
      return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
    }
    userId = row.id;
    method = "legacy_password";
  }

  const refusal = legacyLoginRefusal(userId);
  // unlinked_only refuses linked accounts, which linkExistingUser refuses too (account_already_linked).
  if (refusal && refusal.error !== "sso_required") return NextResponse.json({ error: refusal.error }, { status: refusal.status });

  const linked = linkExistingUser({
    issuer: pending.issuer,
    subject: pending.subject,
    userId,
    method: `app_proof:${method}`,
    proof: { method, at: Date.now() },
    actor: `user:${userId}`,
  });
  if (!linked.ok) return NextResponse.json({ error: linked.error }, { status: LINK_ERRORS[linked.error] ?? 400 });

  // Best effort, not awaited: the local link is authoritative for aindrive.
  void reportAppProof(config, { sub: pending.subject, legacyUserId: userId, method });
  return finish(pending, userId);
}
