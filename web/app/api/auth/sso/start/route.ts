/**
 * GET /api/auth/sso/start?next=/d/… — begins "Continue with AIN": a fresh
 * state, nonce and PKCE verifier are stored server-side (sso_login_requests),
 * bound to this browser by an HttpOnly cookie, and the browser is sent to
 * AIN SSO's authorization endpoint. 404 while SSO login is off.
 */
import { safeNextPath } from "@/lib/safe-next";
import { ssoLoginConfig, ssoRedirectUri } from "@/lib/sso/config";
import { buildAuthorizationUrl, discover } from "@/lib/sso/oidc";
import { createLoginRequest } from "@/lib/sso/store.js";
import { loginError, redirectTo, setTxCookie } from "@/lib/sso/signin";

export async function GET(req: Request) {
  const config = ssoLoginConfig();
  if (!config) return Response.json({ error: "sso_not_configured" }, { status: 404 });
  let meta;
  try { meta = await discover(config.issuer); } catch (e) {
    console.error("[sso] discovery failed:", (e as Error).message);
    return loginError("sso_unavailable");
  }
  const nextPath = safeNextPath(new URL(req.url).searchParams.get("next"));
  const { url, pending } = buildAuthorizationUrl(meta, config.clientId, ssoRedirectUri());
  const id = createLoginRequest({ state: pending.state, nonce: pending.nonce, codeVerifier: pending.codeVerifier, redirectUri: pending.redirectUri, nextPath });
  await setTxCookie(id);
  return redirectTo(url, 302);
}
