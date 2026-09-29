import { NextResponse } from "next/server";
import { dropDeadSessionCookie, getUser } from "@/lib/session";
import { loginWallets, adoptOwnerPayoutWallet } from "@/lib/drives";
import { silentSsoEnabled } from "@/lib/sso/silent";

/** The signed-in account, with the wallets it can sign in with (`wallet` = the first). */
export async function GET() {
  const user = await getUser();
  if (!user) {
    // A dead cookie would keep the next page view from the silent check (lib/sso/stale-session.ts).
    if (silentSsoEnabled()) await dropDeadSessionCookie();
    return NextResponse.json({ user: null }, { status: 401 });
  }
  const wallets = loginWallets(user.id);
  // Apps call this on open: sessions from before sign-in wallets became payout wallets catch up here.
  if (wallets[0]) adoptOwnerPayoutWallet(user.id, wallets[0]);
  return NextResponse.json({ user: { ...user, wallet: wallets[0] ?? null, wallets } });
}
