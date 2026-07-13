"use client";
import { useState, useCallback } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { SiweMessage } from "siwe";

// Mirrors server activeChainId() (web/lib/payment-tokens.ts) — the client
// reads the same NEXT_PUBLIC_ switch. Base mainnet 8453 / Sepolia 84532.
const CHAIN_ID =
  process.env.NEXT_PUBLIC_AINDRIVE_PAYMENT_NETWORK === "mainnet" ? 8453 : 84532;

/**
 * Sign-In With Ethereum (SIWE) that establishes a real aindrive SESSION.
 *
 * Sibling of useWalletLogin (which only re-issues the wallet-ownership cookie
 * via /api/wallet/verify). This one hits /api/wallet/login, which mints an
 * aindrive_session for the wallet's account — the no-email login. Login is a
 * separate proof from payment; the paywall's x402 signature never logs you in.
 *
 * A wallet linked to a real email account that hasn't opted into wallet-login
 * gets 403 `wallet_login_not_enabled`; surfaced verbatim so the caller can show
 * "sign in with email instead".
 *
 * Flow: POST /api/wallet/nonce → build SiweMessage → sign → POST
 * /api/wallet/login (sets the session cookie). Returns { login, busy, error }.
 */
export function useWalletSession() {
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

      const res = await fetch("/api/wallet/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, signature, nonce, message }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (res.status === 403 && body.error === "wallet_login_not_enabled") {
          throw new Error("This wallet is linked to an email account — sign in with email, or enable wallet login from settings.");
        }
        throw new Error(body.error || "login failed");
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
