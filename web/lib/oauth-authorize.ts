/**
 * What a visit of /oauth/authorize does (app/oauth/authorize/page.tsx), and
 * the one approval it shares with the consent form's POST
 * (app/api/oauth/authorize):
 *
 *   invalid request            → the error page; never a redirect to the client
 *   not signed in              → sign in, then back to this same request (signInLocation)
 *   trusted client, in bounds, → the code at once: the same approval as "Allow"
 *   signed in through AIN SSO    (lib/oauth.ts skipsConsent + sameAinPerson)
 *   anything else              → the consent page
 *
 * A trusted client's exact login_hint can also name a verified Google subject
 * or an enabled linked wallet. It must belong to the current Drive user;
 * email/name matching and hints for another account never skip consent.
 * With no hint, only a live AIN SSO session skips the screen, as before.
 *
 * Signing in, for a trusted client with AIN SSO login on: a silent check first
 * (prompt=none, once per browser per 30 min — the `ain_sso_checked` guard of
 * lib/sso/silent.ts), so a person with a live AIN session sees no sign-in page
 * at all. If that fails (login_required & co.) the callback returns here
 * anonymous, and then the person goes to AIN SSO's own sign-in (they are AIN
 * users: the app signed them in with it). /login instead — which offers
 * "Continue with AIN" beside the legacy methods the operator still allows —
 * for every other client (as before: anyone can register one), after a
 * sign-out in this browser (the guard's `signed_out`), and for someone back
 * from "Not now" on /sso/link (signed in at AIN, no aindrive account linked).
 * With SSO login off: /login, as before.
 */
import { db } from "./db";
import { cookies } from "next/headers";
import { currentSsoSession, getUser, type SessionUser } from "./session";
import { clampScope, type McpScope } from "./mcp-tokens";
import {
  accountScopeString,
  isTrustedClient,
  issueAccountCode,
  issueCode,
  redirectWith,
  scopeString,
  skipsConsent,
  validateAuthorize,
  type AuthorizeParams,
  type ValidAuthorize,
} from "./oauth";
import { ssoLoginConfig } from "./sso/config";
import { silentSsoEnabled, SSO_CHECKED_COOKIE, SSO_SIGNED_OUT } from "./sso/silent";
import { LINK_COOKIE } from "./sso/signin";
import { getPendingLink } from "./sso/store.js";

export const AUTHORIZE_KEYS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "scope", "state", "resource", "login_hint"] as const;

/** The authorization parameters of a query (a repeated or missing key is null). */
export function authorizeParamsFrom(sp: Record<string, string | string[] | undefined>): AuthorizeParams {
  const params: AuthorizeParams = {};
  for (const k of AUTHORIZE_KEYS) {
    const v = sp[k];
    params[k] = typeof v === "string" ? v : null;
  }
  return params;
}

/** This same authorization request as a same-origin path (a sign-in's `next`). */
export function authorizePath(params: AuthorizeParams): string {
  const qs = new URLSearchParams(Object.entries(params).filter(([, x]) => x) as [string, string][]);
  return `/oauth/authorize?${qs}`;
}

/**
 * Where an anonymous visitor of a valid authorization request goes to sign
 * in; every path returns to the same request (`next`, checked by
 * safeNextPath on the way back).
 */
export async function signInLocation(params: AuthorizeParams): Promise<string> {
  const next = encodeURIComponent(authorizePath(params));
  const login = `/login?next=${next}`;
  // Any site can register a client and link here: only the operator's own
  // apps get the automatic AIN sign-in.
  if (!ssoLoginConfig() || !isTrustedClient(params.client_id)) return login;
  const jar = await cookies();
  const guard = jar.get(SSO_CHECKED_COOKIE)?.value;
  if (!guard && silentSsoEnabled()) return `/api/auth/sso/start?prompt=none&next=${next}`;
  // Signed out of aindrive in this browser: AIN may still have a session, and
  // its sign-in would complete without a page — the sign-out must hold.
  if (guard === SSO_SIGNED_OUT) return login;
  if (getPendingLink(jar.get(LINK_COOKIE)?.value)) return login; // "Not now"
  return `/api/auth/sso/start?next=${next}`;
}

/**
 * The session is the AIN person the trusted client means: a live AIN SSO
 * session (of the configured issuer) of this user and, when the request
 * carries `login_hint`, of that AIN subject. Provider-prefixed hints additionally
 * match the verified Google or wallet link of the current session account.
 */
export async function sameAinPerson(userId: string, loginHint: string | null | undefined): Promise<boolean> {
  // A fixed trusted callback and its PKCE/state bind the grant to the initiating
  // Ainize account. Match provider subjects, never email addresses or names.
  if (loginHint?.startsWith("google:")) {
    return !!db.prepare("SELECT 1 FROM account_google WHERE account_id = ? AND sub = ?").get(userId, loginHint.slice(7));
  }
  if (/^0x[0-9a-f]{40}$/.test(loginHint ?? "")) {
    return !!db.prepare("SELECT 1 FROM account_wallets WHERE account_id = ? AND wallet_address = ? AND login_enabled = 1").get(userId, loginHint);
  }
  const cfg = ssoLoginConfig();
  const s = await currentSsoSession();
  if (!cfg || !s || s.user_id !== userId || s.issuer !== cfg.issuer) return false;
  const subject = loginHint?.startsWith("sso:") ? loginHint.slice(4) : loginHint;
  return !subject || s.subject === subject;
}

export type Approval = { ok: true; redirect: string } | { ok: false; error: string };

/**
 * "Allow": issue the code and return the client's redirect. The code row
 * (oauth_codes / account_oauth_codes: client, user, scope, redirect, PKCE,
 * time) is the grant's record, whether the person clicked or the client is
 * trusted. A drive grant's scope is clamped to the person's role; no role in
 * the drive → refused. Consented in an AIN SSO session of an organization →
 * the grant is that org's (`sso_org_id`) and ends when the org suspends or
 * offboards the person (lib/sso).
 */
export async function approve(v: ValidAuthorize, userId: string, scopeChoice?: McpScope): Promise<Approval> {
  const { client, redirectUri, codeChallenge, state } = v;
  const ssoOrgId = (await currentSsoSession())?.org_id ?? null;
  if (v.driveId === null) {
    const code = issueAccountCode({ clientId: client.client_id, userId, scopes: v.accountScopes, redirectUri, codeChallenge, ssoOrgId });
    return { ok: true, redirect: redirectWith(redirectUri, { code, state }) };
  }
  const scope = clampScope(v.driveId, userId, scopeChoice ?? v.requestedScope);
  if (!scope) return { ok: false, error: "You don't have access to this drive." };
  const code = issueCode({ clientId: client.client_id, userId, driveId: v.driveId, scope, redirectUri, codeChallenge, ssoOrgId });
  return { ok: true, redirect: redirectWith(redirectUri, { code, state }) };
}

export type AuthorizeStep =
  | { kind: "invalid"; error: string }
  /** A sign-in (same-origin path) or the client's redirect_uri carrying the code. */
  | { kind: "redirect"; location: string }
  | { kind: "consent"; value: ValidAuthorize; user: SessionUser };

export async function authorizeStep(params: AuthorizeParams): Promise<AuthorizeStep> {
  const v = validateAuthorize(params);
  if (!v.ok) return { kind: "invalid", error: v.error };
  // Null also for an account AIN SSO suspended or offboarded: no session of it verifies.
  const user = await getUser();
  if (!user) return { kind: "redirect", location: await signInLocation(params) };
  if (skipsConsent(v.value) && (await sameAinPerson(user.id, params.login_hint))) {
    const approved = await approve(v.value, user.id);
    if (approved.ok) {
      const scope = v.value.driveId === null ? accountScopeString(v.value.accountScopes) : `${scopeString(v.value.requestedScope)} (${v.value.driveId})`;
      console.info(`[oauth] consent skipped for trusted client ${v.value.client.client_id}: user ${user.id}, ${scope}`);
      return { kind: "redirect", location: approved.redirect };
    }
    // No role in the requested drive: the consent page says so.
  }
  return { kind: "consent", value: v.value, user };
}
