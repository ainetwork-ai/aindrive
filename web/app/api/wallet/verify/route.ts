import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyMessage, isAddress } from "viem";
import { challengeMessage, consumeNonce, setWalletCookie } from "@/lib/wallet";

const Body = z.object({
  address: z.string().refine((v) => isAddress(v), "invalid address"),
  signature: z.string().min(2),
  nonce: z.string().min(8),
});

export async function POST(req: Request) {
  const body = Body.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const { address, signature, nonce } = body.data;

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim()
    || req.headers.get("x-real-ip")
    || "anon";
  if (!consumeNonce(ip, nonce)) {
    return NextResponse.json({ error: "unknown or expired nonce" }, { status: 400 });
  }

  const message = challengeMessage(nonce, address.toLowerCase());
  let ok = false;
  try {
    ok = await verifyMessage({
      address: address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    ok = false;
  }
  if (!ok) return NextResponse.json({ error: "bad signature" }, { status: 401 });

  await setWalletCookie(address);
  return NextResponse.json({ ok: true, address: address.toLowerCase() });
}
