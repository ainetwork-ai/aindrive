import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { loginWallets } from "@/lib/drives";

/** The signed-in account, with the wallets it can sign in with (`wallet` = the first). */
export async function GET() {
  const user = await getUser();
  if (!user) return NextResponse.json({ user: null }, { status: 401 });
  const wallets = loginWallets(user.id);
  return NextResponse.json({ user: { ...user, wallet: wallets[0] ?? null, wallets } });
}
