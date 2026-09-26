import { clearCookie } from "@/lib/session";
import { clearWalletCookie } from "@/lib/wallet";
import { safeNextPath } from "@/lib/safe-next";

/** POST [?next=/d/…] — sign out; with `next`, go to sign-in and come back there ("switch account"). */
export async function POST(req: Request) {
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
  return new Response(null, {
    status: 303,
    headers: { Location: next !== "/" ? `/login?next=${encodeURIComponent(next)}` : "/" },
  });
}
