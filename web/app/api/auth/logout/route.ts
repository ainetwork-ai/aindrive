import { clearCookie, endCurrentSsoSession } from "@/lib/session";
import { clearWalletCookie } from "@/lib/wallet";
import { safeNextPath } from "@/lib/safe-next";
import { ssoLoginConfig, ssoPostLogoutRedirectUri } from "@/lib/sso/config";
import { cachedMetadata, discover, endSessionUrl } from "@/lib/sso/oidc";
import { markSilentChecked } from "@/lib/sso/signin";
import { authPostRefusal } from "@/lib/auth-csrf";

/** POST [?next=/d/…] — sign out; with `next`, go to sign-in and come back there ("switch account"). */
export async function POST(req: Request) {
  // Another site can't sign this browser out (lib/auth-csrf.ts); the forms
  // that post here are same-origin, so they carry our Origin.
  const csrf = authPostRefusal(req, { json: false });
  if (csrf) return csrf;
  // An AIN SSO sign-in has a server-side session row: end it first, so the
  // cookie is dead even if the browser kept a copy (lib/sso/README.md).
  const sso = await endCurrentSsoSession();
  // Clear BOTH credentials: the session cookie (identity) AND the wallet
  // cookie. The wallet cookie authorizes the AI-agent tier / rate-limit
  // budget (lib/tier.ts getUserTier → getWallet), so leaving it set would
  // keep a "logged out" user on their wallet-derived tier.
  await clearCookie();
  await clearWalletCookie();
  // Use a relative Location so the browser resolves against the public URL
  // it requested (e.g. https://aindrive.ainetwork.ai/) instead of the
  // container's bind address (which leaks via NextResponse.redirect's
  // absolute URL construction when behind a reverse proxy).
  const raw = new URL(req.url).searchParams.get("next");
  const next = raw ? safeNextPath(raw) : "/";   // unsafe or missing → "/" (plain sign-out)
  const cfg = ssoLoginConfig();
  // Every sign-out sets the silent check's loop guard (lib/sso/silent.ts), so
  // an AIN session this browser may still have does not sign it straight back
  // in: a legacy sign-in or "switch account" ends only aindrive's session, and
  // AIN SSO's sign-out page also offers "Stay signed in", which ends only
  // aindrive's grant and still returns here. Nothing changes while SSO is off.
  // Marked as a sign-out: /oauth/authorize then sends even a trusted app's
  // request to /login, not to AIN's sign-in (lib/oauth-authorize.ts).
  if (cfg) await markSilentChecked("signed_out");
  if (next === "/" && sso) {
    // Plain sign-out of an AIN session: RP-initiated logout at AIN SSO, which
    // ends the central session and signs the other apps out (back-channel).
    let url: string | null = null;
    if (cfg && cfg.issuer === sso.issuer) {
      const meta = cachedMetadata(cfg.issuer) ?? (await discover(cfg.issuer).catch(() => null));
      url = endSessionUrl(meta, cfg.clientId, ssoPostLogoutRedirectUri());
    }
    if (url) return new Response(null, { status: 303, headers: { Location: url } });
  }
  return new Response(null, {
    status: 303,
    headers: { Location: next !== "/" ? `/login?next=${encodeURIComponent(next)}` : "/" },
  });
}
