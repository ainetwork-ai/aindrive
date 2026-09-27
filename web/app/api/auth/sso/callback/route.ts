/**
 * GET /api/auth/sso/callback — AIN SSO's redirect back. Validates the
 * response against this browser's pending request (RFC 9207 iss, state),
 * exchanges the code with the PKCE verifier (client_secret_basic), validates
 * the ID token (signature via JWKS, iss, aud/azp, exp, nonce) and resolves
 * the aindrive account by (issuer, sub) ONLY — never by email:
 *
 *   linked            → that account (refused while suspended) → session
 *   not linked yet    → /sso/link: connect an existing account with a proof,
 *                       or create one (just in time); with
 *                       AINDRIVE_LEGACY_LOGIN=false there is no legacy proof,
 *                       so the account is created directly.
 *
 * Errors come back to /login?sso_error=<code>.
 */
import { legacyLoginMode, ssoLoginConfig } from "@/lib/sso/config";
import { completeAuthorization, discover, sessionOrg, SsoError } from "@/lib/sso/oidc";
import { createPendingLink, identityFor, isAccountBlocked, resolveOrCreateUserForSubject, takeLoginRequest } from "@/lib/sso/store.js";
import { beginSsoSession, clearTxCookie, loginError, readTxCookie, redirectTo, setLinkCookie } from "@/lib/sso/signin";

export async function GET(req: Request) {
  const config = ssoLoginConfig();
  if (!config) return Response.json({ error: "sso_not_configured" }, { status: 404 });

  const pending = takeLoginRequest(await readTxCookie());
  await clearTxCookie();
  if (!pending) return loginError("expired");

  let identity;
  try {
    const meta = await discover(config.issuer);
    identity = await completeAuthorization({
      config,
      meta,
      params: new URL(req.url).searchParams,
      pending: { state: pending.state, nonce: pending.nonce, codeVerifier: pending.code_verifier, redirectUri: pending.redirect_uri },
    });
  } catch (e) {
    if (e instanceof SsoError) {
      if (e.code !== "access_denied") console.warn("[sso] sign-in rejected:", e.code, e.message);
      return loginError(e.code);
    }
    console.error("[sso] callback failed:", (e as Error).message);
    return loginError("sso_unavailable");
  }

  const session = { issuer: config.issuer, subject: identity.sub, oidcSid: identity.sid, orgId: sessionOrg(identity), orgIds: identity.orgs.map((o) => o.id) };
  const linked = identityFor(config.issuer, identity.sub);
  if (linked) {
    if (isAccountBlocked(linked.user_id)) return loginError("account_suspended");
    await beginSsoSession(linked.user_id, session);
    return redirectTo(pending.next_path);
  }

  if (legacyLoginMode() === "false") {
    const { userId } = resolveOrCreateUserForSubject({ issuer: config.issuer, subject: identity.sub, name: identity.name, email: identity.email, emailVerified: identity.emailVerified });
    if (isAccountBlocked(userId)) return loginError("account_suspended");
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
