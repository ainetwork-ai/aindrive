/**
 * /sso/link — an AIN sign-in whose AIN account is not linked to an aindrive
 * account yet (app/api/auth/sso/callback). The person either proves an
 * existing aindrive account once (the session this browser already has, or
 * its password; a wallet or Google account: sign in with it first and come
 * back) or creates a new account. Never decided by email. "Not now" returns
 * to the page the sign-in started from without signing in (the automatic
 * check of lib/sso/silent.ts lands here too).
 */
import { cookies } from "next/headers";
import Link from "next/link";
import { getUser } from "@/lib/session";
import { legacyLoginMode, ssoLoginEnabled } from "@/lib/sso/config";
import { getPendingLink, isAccountBlocked, isSsoLinked } from "@/lib/sso/store.js";
import { LINK_COOKIE } from "@/lib/sso/signin";
import { walletDisplayLabel } from "@/shared/wallet-display";
import SsoLinkForm from "./link-form";

export const dynamic = "force-dynamic";

export default async function SsoLinkPage() {
  const pending = ssoLoginEnabled() ? getPendingLink((await cookies()).get(LINK_COOKIE)?.value) : null;
  if (!pending) {
    return (
      <main className="min-h-screen min-h-dvh flex items-center justify-center px-6">
        <div className="w-full max-w-sm bg-white border border-drive-border rounded-2xl p-6 shadow-drive text-sm">
          <h1 className="text-xl font-semibold">Sign-in expired</h1>
          <p className="mt-3 text-drive-muted">This AIN sign-in is no longer waiting. Start again from the sign-in page.</p>
          <Link href="/login" className="mt-5 inline-block text-drive-accent hover:underline">Go to sign in</Link>
        </div>
      </main>
    );
  }
  const user = await getUser();
  const current = user && !isSsoLinked(user.id) && !isAccountBlocked(user.id)
    ? { label: walletDisplayLabel(user.email, user.name), email: user.email }
    : null;
  return (
    <main className="min-h-screen min-h-dvh flex items-center justify-center px-6">
      <SsoLinkForm
        ain={{ name: pending.name, email: pending.email }}
        current={current}
        allowLegacy={legacyLoginMode() !== "false"}
        skipHref={pending.next_path}
      />
    </main>
  );
}
