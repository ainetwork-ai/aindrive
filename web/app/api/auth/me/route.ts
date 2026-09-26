import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { loginWallets, adoptOwnerPayoutWallet } from "@/lib/drives";

/** The signed-in account, with the wallets it can sign in with (`wallet` = the first). */
export async function GET() {
  const user = await getUser();
  if (!user) return NextResponse.json({ user: null }, { status: 401 });
  const wallets = loginWallets(user.id);
  // Apps call this on open: sessions from before sign-in wallets became payout wallets catch up here.
  if (wallets[0]) adoptOwnerPayoutWallet(user.id, wallets[0]);
  return NextResponse.json({ user: { ...user, wallet: wallets[0] ?? null, wallets } });
}
