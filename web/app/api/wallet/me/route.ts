import { NextResponse } from "next/server";
import { getWallet } from "@/lib/wallet";

export async function GET() {
  const address = await getWallet();
  return NextResponse.json({ address });
}
