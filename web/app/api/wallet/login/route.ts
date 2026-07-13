import { NextResponse } from "next/server";
import { z } from "zod";
import { isAddress } from "viem";
import { SiweMessage } from "siwe";
import { consumeNonce, resolveAccountForWallet, walletLoginAccount } from "@/lib/wallet";
import { verifyWalletSignature } from "@/lib/siwe-verify";
import { setCookie } from "@/lib/session";
import { tryConsume, clientKey } from "@/lib/rate-limit";
import { env } from "@/lib/env";

// The SIWE message must be signed FOR this origin; binding verify() to our
// canonical host rejects a signature phished on another site.
const EXPECTED_DOMAIN = new URL(env.publicUrl).host;

const Body = z.object({
  address: z.string().refine((v) => isAddress(v), "invalid address"),
  signature: z.string().min(2),
  nonce: z.string().min(8),
  message: z.string().min(10),
});

// Wallet-only LOGIN: prove wallet ownership via SIWE, then mint the real
// aindrive_session. Distinct from /api/wallet/verify (which only re-issues the
// wallet-ownership cookie) — this establishes an account session with no email.
// Login is a separate proof from payment (never mint a session from a payment).
export async function POST(req: Request) {
  const rl = tryConsume({ name: "wallet-login", key: clientKey(req, "wallet-login"), limit: 10, windowMs: 60_000 });
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

  let siweMsg: SiweMessage;
  try {
    siweMsg = new SiweMessage(message);
  } catch {
    return NextResponse.json({ error: "bad message" }, { status: 400 });
  }
  if (siweMsg.nonce !== nonce) {
    return NextResponse.json({ error: "nonce mismatch" }, { status: 400 });
  }
  if (siweMsg.address.toLowerCase() !== address.toLowerCase()) {
    return NextResponse.json({ error: "address mismatch" }, { status: 400 });
  }

  const ok = await verifyWalletSignature({ message, signature, address, nonce, domain: EXPECTED_DOMAIN });
  if (!ok) return NextResponse.json({ error: "bad signature" }, { status: 401 });

  // Provenance gate: a wallet linked to a real (email) account that hasn't
  // opted into wallet-login must NOT mint a session — payment/attribution
  // linking is not login consent. Unknown wallets mint a login-enabled
  // placeholder; placeholders are login-enabled by construction.
  const existing = walletLoginAccount(address);
  if (existing && !existing.loginEnabled) {
    return NextResponse.json({ error: "wallet_login_not_enabled" }, { status: 403 });
  }
  const accountId = existing?.accountId ?? resolveAccountForWallet(address);

  await setCookie(accountId);
  return NextResponse.json({ ok: true, address: address.toLowerCase() });
}
