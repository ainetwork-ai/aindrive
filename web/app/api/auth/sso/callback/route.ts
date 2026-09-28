/**
 * GET /api/auth/sso/callback — AIN SSO's redirect back. Validates the
 * response against this browser's pending request (RFC 9207 iss, state),
 * exchanges the code with the PKCE verifier (client_secret_basic), validates
 * the ID token (signature via JWKS, iss, aud/azp, exp, nonce) and resolves
 * the aindrive account by (issuer, sub) ONLY — never by email:
 *
 *   linked            → that account (refused while suspended) → session
 *   not linked yet    → /sso/link: connect an existing account with a proof,
 *   (or only to a       or create one (just in time); with
 *   placeholder the     AINDRIVE_LEGACY_LOGIN=false there is no legacy proof,
 *   adapter made)       so the account is created directly.
 *
 * Errors come back to /login?sso_error=<code> — except for the silent check
 * (prompt=none, lib/sso/silent.ts): `login_required`, `access_denied` & co.
 * (and any other failure) return to the requested page as an anonymous
 * visitor. A `prompt=create` sign-up that ends in an existing AIN account is
 * an ordinary sign-in.
 */
import { legacyLoginMode, ssoLoginConfig } from "@/lib/sso/config";
import { completeAuthorization, discover, sessionOrg, SsoError } from "@/lib/sso/oidc";
import { SILENT_ERRORS, SILENT_QUIET_ERRORS } from "@/lib/sso/silent";
import { createPendingLink, identityFor, isAccountBlocked, isPlaceholderIdentity, resolveOrCreateUserForSubject, takeLoginRequest } from "@/lib/sso/store.js";
import { beginSsoSession, clearTxCookie, loginError, readTxCookie, redirectTo, setLinkCookie } from "@/lib/sso/signin";

export async function GET(req: Request) {
  const config = ssoLoginConfig();
  if (!config) return Response.json({ error: "sso_not_configured" }, { status: 404 });

  const params = new URL(req.url).searchParams;
  const pending = takeLoginRequest(await readTxCookie());
  await clearTxCookie();
  // An answer to a silent check is never an error page, even when this
  // browser's pending request is gone (e.g. two tabs raced for the one cookie).
  const silentAnswer = SILENT_ERRORS.has(params.get("error") ?? "");
  if (!pending) return silentAnswer ? redirectTo("/") : loginError("expired");
  const silent = pending.prompt === "none" || silentAnswer;
  /** The silent check failed or the person must interact: back to the page, anonymous. */
  const anonymous = (code: string) => {
    if (!SILENT_QUIET_ERRORS.has(code)) console.warn("[sso] silent sign-in ended:", code);
    return redirectTo(pending.next_path);
  };

  let identity;
  try {
    const meta = await discover(config.issuer);
    identity = await completeAuthorization({
      config,
      meta,
      params,
      pending: { state: pending.state, nonce: pending.nonce, codeVerifier: pending.code_verifier, redirectUri: pending.redirect_uri },
    });
  } catch (e) {
    if (e instanceof SsoError) {
      if (silent) return anonymous(e.code);
      if (e.code !== "access_denied") console.warn("[sso] sign-in rejected:", e.code, e.message);
      return loginError(e.code);
    }
    console.error("[sso] callback failed:", (e as Error).message);
    return silent ? anonymous("sso_unavailable") : loginError("sso_unavailable");
  }

  const session = { issuer: config.issuer, subject: identity.sub, oidcSid: identity.sid, orgId: sessionOrg(identity), orgIds: identity.orgs.map((o) => o.id) };
  const legacy = legacyLoginMode();
  const linked = identityFor(config.issuer, identity.sub);
  if (linked) {
    if (isAccountBlocked(linked.user_id)) return silent ? anonymous("account_suspended") : loginError("account_suspended");
    // A placeholder the provisioning adapter made (never signed in) is not the
    // person's account yet: they may still connect their legacy one.
    if (!(legacy !== "false" && isPlaceholderIdentity(linked))) {
      await beginSsoSession(linked.user_id, session);
      return redirectTo(pending.next_path);
    }
  } else if (legacy === "false") {
    const { userId } = resolveOrCreateUserForSubject({ issuer: config.issuer, subject: identity.sub, name: identity.name, email: identity.email, emailVerified: identity.emailVerified });
    if (isAccountBlocked(userId)) return silent ? anonymous("account_suspended") : loginError("account_suspended");
    await beginSsoSession(userId, session);
    return redirectTo(pending.next_path);
  }

  const linkId = createPendingLink({
    issuer: config.issuer,
    subject: identity.sub,
    name: identity.name,
    email: identity.email,
    emailVerified: identity.emailVerified,
    oidcSid: identity.sid,
    orgId: session.orgId,
    orgIds: session.orgIds,
    nextPath: pending.next_path,
  });
  await setLinkCookie(linkId);
  return redirectTo("/sso/link");
}
