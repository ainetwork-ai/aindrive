import { NextResponse } from "next/server";
import { issueNonce } from "@/lib/wallet";

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim()
    || req.headers.get("x-real-ip")
    || "anon";
  const { nonce, expiresAt } = issueNonce(ip);
  return NextResponse.json({ nonce, expiresAt });
}
