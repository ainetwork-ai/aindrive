"use client";
import { useState, useCallback } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { SiweMessage } from "siwe";

// Mirrors server activeChainId() (web/lib/payment-tokens.ts). Base 8453 / Sepolia 84532.
const CHAIN_ID =
  process.env.NEXT_PUBLIC_AINDRIVE_PAYMENT_NETWORK === "mainnet" ? 8453 : 84532;

/**
 * Link the connected wallet to the CURRENT (logged-in) account via SIWE, opting
 * into wallet-login (login_enabled=1). Run while already authenticated (email
 * account), it attaches the wallet as an additional sign-in credential — the
 * counterpart to the /login wallet flow, which mints a session FROM a wallet.
 *
 * The authenticated session + this SIWE signature ARE the login-consent proof
 * (a payment/attribution link never sets login_enabled on its own).
 *
 * Flow: POST /api/wallet/nonce → sign SIWE → POST /api/wallet/link
 * { enableLogin: true }. Returns { link, busy, error, isConnected, address }.
 */
export function useWalletLink() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const link = useCallback(async (): Promise<boolean> => {
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

      const res = await fetch("/api/wallet/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, signature, nonce, message, enableLogin: true }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (res.status === 409) throw new Error("This wallet is already linked to another account.");
        if (res.status === 401) throw new Error("Sign in first, then add a wallet.");
        throw new Error(body.error || "could not add wallet");
      }
      return true;
    } catch (e) {
      setError((e as Error).message || "could not add wallet");
      return false;
    } finally {
      setBusy(false);
    }
  }, [address, isConnected, signMessageAsync]);

  return { link, busy, error, isConnected, address };
}
