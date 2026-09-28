/**
 * App attestation (AIN SSO management-api §13.2, owner decisions 2026-09-27):
 * right after someone signs in with a LEGACY method, aindrive tells AIN SSO
 * what it verified about that legacy user, so their AIN account links to it
 * without an administrator:
 *
 *   Google sign-in   {legacyUserId, googleSub, legacyLoginAt} — the verified
 *                    Google `sub` stored in account_google; any email domain
 *   password         {legacyUserId, email, emailVerifiedBy: "password",
 *   (and signup)     legacyLoginAt} — only for an address on a company domain
 *                    (AINDRIVE_SSO_ATTEST_EMAIL_DOMAINS, default comcom.ai)
 *                    that aindrive itself verified by an emailed code (signup,
 *                    password reset or email attach); otherwise nothing is sent
 *   wallet (SIWE), SSO, already-linked accounts   nothing
 *
 * `POST {issuer}/api/upstream/app-attest`, client_secret_basic, JSON, no
 * cookies, 3 s timeout. Best effort: never awaited by the login, never
 * changes it; at most one call per login. Results go to sso_audit and the
 * log without the address or the Google sub.
 */
import { db } from "../db";
import { attestConfig, attestEmailDomains, type SsoLoginConfig } from "./config";
import { audit, isReservedEmail, isSsoLinked } from "./store.js";

export type AttestBody =
  | { legacyUserId: string; googleSub: string; legacyLoginAt: string }
  | { legacyUserId: string; email: string; emailVerifiedBy: "password"; legacyLoginAt: string };

export type LegacyLogin =
  | { userId: string; method: "password" }
  | { userId: string; method: "google"; googleSub: string };

export type AttestOutcome = { status: number; code: string | null; result: string | null };

/** True when `email` is on one of the configured company domains (exact domain match). */
export function isAttestableEmail(email: string | null | undefined): boolean {
  const e = String(email ?? "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1 || isReservedEmail(e)) return false;
  return attestEmailDomains().includes(e.slice(at + 1));
}

/**
 * The account's address, when aindrive verified it by an emailed code: the
 * signup code consumed as the account was created, or a password-reset /
 * email-attach code consumed after it was. Accounts from before signup
 * verification (and dev-bypass signups) have no such code → null.
 */
export function otpVerifiedEmail(userId: string): string | null {
  const row = db
    .prepare(
      `SELECT lower(u.email) AS email FROM users u
       WHERE u.id = ? AND (
         EXISTS (SELECT 1 FROM email_verification_codes c
                 WHERE c.email = lower(u.email) AND c.purpose = 'signup' AND c.verified_at IS NOT NULL
                   AND c.verified_at BETWEEN CAST(strftime('%s', u.created_at) AS INTEGER) * 1000 - 600000
                                         AND CAST(strftime('%s', u.created_at) AS INTEGER) * 1000 + 1000)
         OR EXISTS (SELECT 1 FROM email_verification_codes c
                 WHERE c.email = lower(u.email) AND c.purpose IN ('reset_password', 'attach_email') AND c.verified_at IS NOT NULL
                   AND c.verified_at >= CAST(strftime('%s', u.created_at) AS INTEGER) * 1000)
       )`,
    )
    .get(userId) as { email: string } | undefined;
  return row?.email ?? null;
}

/** What to send for this legacy login, or null (nothing to attest). */
export function attestationFor(login: LegacyLogin, legacyLoginAt: string): AttestBody | null {
  if (isSsoLinked(login.userId)) return null; // already linked: AIN SSO has nothing to learn
  if (login.method === "google") {
    return login.googleSub ? { legacyUserId: login.userId, googleSub: login.googleSub, legacyLoginAt } : null;
  }
  const email = otpVerifiedEmail(login.userId);
  if (!email || !isAttestableEmail(email)) return null;
  return { legacyUserId: login.userId, email, emailVerifiedBy: "password", legacyLoginAt };
}

const variant = (b: AttestBody) => ("googleSub" in b ? "google_sub" : "email");

export async function postAppAttest(config: SsoLoginConfig, body: AttestBody, fetchImpl: typeof fetch = fetch): Promise<AttestOutcome> {
  const basic = Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString("base64");
  const res = await fetchImpl(`${config.issuer.replace(/\/+$/, "")}/api/upstream/app-attest`, {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.timeout(3_000),
  });
  const out = (await res.json().catch(() => null)) as { error?: unknown; status?: unknown } | null;
  return {
    status: res.status,
    code: typeof out?.error === "string" ? out.error.slice(0, 64) : null,
    result: typeof out?.status === "string" ? out.status.slice(0, 32) : null,
  };
}

function record(userId: string, body: AttestBody, o: AttestOutcome | null, error?: string) {
  const ok = !!o && o.status >= 200 && o.status < 300;
  // 403/409/422 are normal answers (not a company address, already linked, …).
  const expected = !!o && [403, 409, 422].includes(o.status);
  const action = ok ? "app_attest_reported" : expected ? "app_attest_rejected" : "app_attest_failed";
  if (!ok && !expected) console.warn("[sso] app-attest failed:", o ? `${o.status} ${o.code ?? ""}`.trim() : error);
  try {
    audit({ actor: `user:${userId}`, action, userId, details: { variant: variant(body), status: o?.status ?? 0, code: o?.code ?? error ?? null, result: o?.result ?? null } });
  } catch {}
}

/**
 * Reports a legacy sign-in to AIN SSO when there is something to attest.
 * Returns the in-flight promise (tests await it; routes `void` it) or null
 * when nothing is sent. Never throws.
 */
export function attestLegacyLogin(login: LegacyLogin, fetchImpl: typeof fetch = fetch): Promise<void> | null {
  const config = attestConfig();
  if (!config) return null;
  let body: AttestBody | null;
  try { body = attestationFor(login, new Date().toISOString()); } catch (e) {
    console.warn("[sso] app-attest skipped:", (e as Error).name);
    return null;
  }
  if (!body) return null;
  const sent = body;
  return (async () => {
    try {
      record(login.userId, sent, await postAppAttest(config, sent, fetchImpl));
    } catch (e) {
      record(login.userId, sent, null, (e as Error).name || "error");
    }
  })();
}
