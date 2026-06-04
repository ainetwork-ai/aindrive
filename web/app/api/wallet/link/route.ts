import { NextResponse } from "next/server";
import { z } from "zod";
import { isAddress } from "viem";
import { SiweMessage } from "siwe";
import { consumeNonce, linkWalletToAccount, WalletAlreadyLinkedError } from "@/lib/wallet";
import { getUser } from "@/lib/session";
import { tryConsume, clientKey } from "@/lib/rate-limit";
import { env } from "@/lib/env";

// The SIWE message must be signed FOR this origin. Binding verify() to our
// canonical host means a signature obtained on another site (phishing) is
// rejected even though the single-use server nonce already blocks replay.
const EXPECTED_DOMAIN = new URL(env.publicUrl).host;

const Body = z.object({
  address: z.string().refine((v) => isAddress(v), "invalid address"),
  signature: z.string().min(2),
  nonce: z.string().min(8),
  message: z.string().min(10),
});

export async function POST(req: Request) {
  const rl = tryConsume({ name: "wallet-link", key: clientKey(req, "wallet-link"), limit: 10, windowMs: 60_000 });
  if (!rl.ok) {
    const retryAfter = Math.ceil(rl.retryAfterMs / 1000);
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(retryAfter) } });
  }

  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

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
    if (siweMsg.nonce !== nonce) {
      return NextResponse.json({ error: "nonce mismatch" }, { status: 400 });
    }
    if (siweMsg.address.toLowerCase() !== address.toLowerCase()) {
      return NextResponse.json({ error: "address mismatch" }, { status: 400 });
    }
    // Pass domain + nonce so siwe enforces origin- and nonce-binding itself
    // (defense in depth on top of the manual checks above).
    const result = await siweMsg.verify({ signature, domain: EXPECTED_DOMAIN, nonce });
    ok = result.success;
  } catch {
    ok = false;
  }
  if (!ok) return NextResponse.json({ error: "bad signature" }, { status: 401 });

  let reclaimed: number;
  try {
    reclaimed = linkWalletToAccount(user.id, address, "siwe");
  } catch (e) {
    if (e instanceof WalletAlreadyLinkedError) {
      return NextResponse.json({ error: "wallet already linked" }, { status: 409 });
    }
    throw e;
  }

  return NextResponse.json({ ok: true, address: address.toLowerCase(), reclaimedReceipts: reclaimed });
}
