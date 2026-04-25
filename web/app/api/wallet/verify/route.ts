import { NextResponse } from "next/server";
import { z } from "zod";
import { isAddress } from "viem";
import { SiweMessage } from "siwe";
import { consumeNonce, setWalletCookie } from "@/lib/wallet";
import { tryConsume, clientKey } from "@/lib/rate-limit";

const Body = z.object({
  address: z.string().refine((v) => isAddress(v), "invalid address"),
  signature: z.string().min(2),
  nonce: z.string().min(8),
  message: z.string().min(10),
});

export async function POST(req: Request) {
  const rl = tryConsume({ name: "wallet-verify", key: clientKey(req, "wallet-verify"), limit: 10, windowMs: 60_000 });
  if (!rl.ok) {
    const retryAfter = Math.ceil(rl.retryAfterMs / 1000);
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(retryAfter) } });
  }
  const body = Body.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const { address, signature, nonce, message } = body.data;

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim()
    || req.headers.get("x-real-ip")
    || "anon";
  if (!consumeNonce(ip, nonce)) {
    return NextResponse.json({ error: "unknown or expired nonce" }, { status: 400 });
  }

  let ok = false;
  try {
    const siweMsg = new SiweMessage(message);
    // Validate the nonce in the message matches what was issued
    if (siweMsg.nonce !== nonce) {
      return NextResponse.json({ error: "nonce mismatch" }, { status: 400 });
    }
    // Validate the address in the message matches the claimed address
    if (siweMsg.address.toLowerCase() !== address.toLowerCase()) {
      return NextResponse.json({ error: "address mismatch" }, { status: 400 });
    }
    const result = await siweMsg.verify({ signature });
    ok = result.success;
  } catch {
    ok = false;
  }
  if (!ok) return NextResponse.json({ error: "bad signature" }, { status: 401 });

  await setWalletCookie(address);
  return NextResponse.json({ ok: true, address: address.toLowerCase() });
}
