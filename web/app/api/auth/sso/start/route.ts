/**
 * GET /api/auth/sso/start?next=/d/…[&prompt=none|create][&ain_idp=google] —
 * begins "Continue with AIN": a fresh state, nonce and PKCE verifier are
 * stored server-side (sso_login_requests), bound to this browser by an
 * HttpOnly cookie, and the browser is sent to AIN SSO's authorization
 * endpoint. 404 while SSO login is off.
 *
 *   prompt=none    the silent check (middleware.ts, lib/sso/silent.ts, or a
 *                  page with a dead session cookie, lib/sso/stale-session.ts):
 *                  any failure returns to `next` as an anonymous visitor
 *   prompt=create  "Sign up with AIN" — AIN SSO's sign-up page
 *   ain_idp=google straight to Google at AIN SSO (no AIN sign-in page)
 */
import { safeNextPath } from "@/lib/safe-next";
import { dropDeadSessionCookie } from "@/lib/session";
import { ssoLoginConfig, ssoRedirectUri } from "@/lib/sso/config";
import { buildAuthorizationUrl, discover, parseIdpHint, parsePrompt } from "@/lib/sso/oidc";
import { createLoginRequest } from "@/lib/sso/store.js";
import { loginError, markSilentChecked, redirectTo, setTxCookie } from "@/lib/sso/signin";

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const nextPath = safeNextPath(params.get("next"));
  const prompt = parsePrompt(params.get("prompt"));
  const config = ssoLoginConfig();
  if (!config) return Response.json({ error: "sso_not_configured" }, { status: 404 });
  // A session cookie whose session ended would keep the middleware from ever
  // checking this browser again (lib/sso/stale-session.ts): drop it.
  await dropDeadSessionCookie();
  // The loop guard, also when a page (not the middleware) started the check.
  if (prompt === "none") await markSilentChecked();
  let meta;
  try { meta = await discover(config.issuer); } catch (e) {
    console.error("[sso] discovery failed:", (e as Error).message);
    return prompt === "none" ? redirectTo(nextPath, 302) : loginError("sso_unavailable");
  }
  const { url, pending } = buildAuthorizationUrl(meta, config.clientId, ssoRedirectUri(), { prompt, idp: parseIdpHint(params.get("ain_idp")) });
  const id = createLoginRequest({ state: pending.state, nonce: pending.nonce, codeVerifier: pending.codeVerifier, redirectUri: pending.redirectUri, nextPath, prompt });
  await setTxCookie(id);
  return redirectTo(url, 302);
}
