import { NextResponse } from "next/server";
import { z } from "zod";
import { isAddress } from "viem";
import { consumeNonce, setWalletCookie } from "@/lib/wallet";
import { parseSiweLoginFields, verifyWalletSignature } from "@/lib/siwe-verify";
import { tryConsume, clientKey } from "@/lib/rate-limit";
import { env } from "@/lib/env";

// SIWE must be signed FOR this origin (anti-phishing); re-checked by the verifier.
const EXPECTED_DOMAIN = new URL(env.publicUrl).host;

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

  // Same parser as the verifier (viem) — see parseSiweLoginFields for why the
  // stricter spruceid parse rejected messages the verifier accepts.
  const siweMsg = parseSiweLoginFields(message);
  if (!siweMsg) {
    console.error("[wallet-verify] unparseable SIWE message:", JSON.stringify(message.slice(0, 300)));
    return NextResponse.json({ error: "bad message" }, { status: 400 });
  }
  // Validate the nonce in the message matches what was issued
  if (siweMsg.nonce !== nonce) {
    return NextResponse.json({ error: "nonce mismatch" }, { status: 400 });
  }
  // Validate the address in the message matches the claimed address
  if (siweMsg.address.toLowerCase() !== address.toLowerCase()) {
    return NextResponse.json({ error: "address mismatch" }, { status: 400 });
  }
  // Smart-wallet capable (EOA + ERC-1271 + ERC-6492) verification on the
  // active Base chain — plain siwe.verify() was EOA-only.
  const ok = await verifyWalletSignature({ message, signature, address, nonce, domain: EXPECTED_DOMAIN });
  if (!ok) return NextResponse.json({ error: "bad signature" }, { status: 401 });

  await setWalletCookie(address);
  return NextResponse.json({ ok: true, address: address.toLowerCase() });
}
