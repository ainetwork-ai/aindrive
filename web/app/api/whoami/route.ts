import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { getWallet } from "@/lib/wallet";

export async function GET() {
  const [user, wallet] = await Promise.all([getUser(), getWallet()]);
  return NextResponse.json({
    name: user?.name ?? null,
    email: user?.email ?? null,
    address: wallet ?? null,
  });
}
