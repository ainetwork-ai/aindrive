import { NextResponse } from "next/server";
import { z } from "zod";
import { isAddress } from "viem";
import { consumeNonce, linkWalletToAccount, WalletAlreadyLinkedError } from "@/lib/wallet";
import { parseSiweLoginFields, verifyWalletSignature } from "@/lib/siwe-verify";
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
  // Opt-in: also enable signing in with this wallet (login_enabled=1). The
  // authenticated session + SIWE signature here ARE the login-consent proof.
  enableLogin: z.boolean().optional(),
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

  // Same parser as the verifier (viem) — see parseSiweLoginFields for why the
  // stricter spruceid parse rejected messages the verifier accepts.
  const siweMsg = parseSiweLoginFields(message);
  if (!siweMsg) {
    console.error("[wallet-link] unparseable SIWE message:", JSON.stringify(message.slice(0, 300)));
    return NextResponse.json({ error: "bad message" }, { status: 400 });
  }
  if (siweMsg.nonce !== nonce) {
    return NextResponse.json({ error: "nonce mismatch" }, { status: 400 });
  }
  if (siweMsg.address.toLowerCase() !== address.toLowerCase()) {
    return NextResponse.json({ error: "address mismatch" }, { status: 400 });
  }
  // Smart-wallet capable (EOA + ERC-1271 + ERC-6492) verification, binding
  // origin + nonce (defense in depth on top of the manual checks above).
  const ok = await verifyWalletSignature({ message, signature, address, nonce, domain: EXPECTED_DOMAIN });
  if (!ok) return NextResponse.json({ error: "bad signature" }, { status: 401 });

  let reclaimed: number;
  try {
    reclaimed = linkWalletToAccount(user.id, address, "siwe", body.data.enableLogin === true);
  } catch (e) {
    if (e instanceof WalletAlreadyLinkedError) {
      return NextResponse.json({ error: "wallet already linked" }, { status: 409 });
    }
    throw e;
  }

  return NextResponse.json({ ok: true, address: address.toLowerCase(), reclaimedReceipts: reclaimed });
}
