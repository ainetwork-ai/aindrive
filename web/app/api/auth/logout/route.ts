import { clearCookie, endCurrentSsoSession } from "@/lib/session";
import { clearWalletCookie } from "@/lib/wallet";
import { safeNextPath } from "@/lib/safe-next";
import { ssoLoginConfig, ssoPostLogoutRedirectUri } from "@/lib/sso/config";
import { cachedMetadata, endSessionUrl } from "@/lib/sso/oidc";

/** POST [?next=/d/…] — sign out; with `next`, go to sign-in and come back there ("switch account"). */
export async function POST(req: Request) {
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
  if (next === "/" && sso) {
    // Plain sign-out of an AIN session: RP-initiated logout at AIN SSO, which
    // ends the central session and signs the other apps out (back-channel).
    const cfg = ssoLoginConfig();
    const url = cfg && cfg.issuer === sso.issuer ? endSessionUrl(cachedMetadata(cfg.issuer), cfg.clientId, ssoPostLogoutRedirectUri()) : null;
    if (url) return new Response(null, { status: 303, headers: { Location: url } });
  }
  return new Response(null, {
    status: 303,
    headers: { Location: next !== "/" ? `/login?next=${encodeURIComponent(next)}` : "/" },
  });
}
