"use client";
import { useState, useCallback } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { SiweMessage } from "siwe";

// Mirrors server activeChainId() (web/lib/payment-tokens.ts) — the client
// reads the same NEXT_PUBLIC_ switch. Base mainnet 8453 / Sepolia 84532.
const CHAIN_ID =
  process.env.NEXT_PUBLIC_AINDRIVE_PAYMENT_NETWORK === "mainnet" ? 8453 : 84532;

/**
 * Sign-In With Ethereum (SIWE) for an already-connected wallet.
 *
 * Distinct from the x402 PAYMENT flow in share-gate.tsx: this proves
 * ownership of a wallet that ALREADY has access (paid earlier, or
 * owner-added), so the server can re-issue the `aindrive_wallet` cookie on
 * a new device/browser. No on-chain transaction, just a signature.
 *
 * Flow: POST /api/wallet/nonce → build SiweMessage → sign → POST
 * /api/wallet/verify (sets the cookie). Returns { login, busy, error }.
 */
export function useWalletLogin() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = useCallback(async (): Promise<boolean> => {
    if (!isConnected || !address) {
      setError("Connect a wallet first");
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      const nonceRes = await fetch("/api/wallet/nonce", { method: "POST" });
      if (!nonceRes.ok) throw new Error("could not get nonce");
      const { nonce } = await nonceRes.json();

      const message = new SiweMessage({
        domain: window.location.host,
        address,
        statement: "aindrive wants you to sign in with your wallet.",
        uri: window.location.origin,
        version: "1",
        chainId: CHAIN_ID,
        nonce,
      }).prepareMessage();

      const signature = await signMessageAsync({ message });

      const verifyRes = await fetch("/api/wallet/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, signature, nonce, message }),
      });
      if (!verifyRes.ok) {
        const body = await verifyRes.json().catch(() => ({}));
        throw new Error(body.error || "verification failed");
      }
      return true;
    } catch (e) {
      setError((e as Error).message || "login failed");
      return false;
    } finally {
      setBusy(false);
    }
  }, [address, isConnected, signMessageAsync]);

  return { login, busy, error, isConnected, address };
}
