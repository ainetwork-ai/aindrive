"use client";

/**
 * The heavy wallet sign-in control, isolated so it can be `next/dynamic`-imported
 * (ssr:false) off the email form: the wagmi + RainbowKit + WalletConnect stack
 * (~300-600KB) loads after first paint, not on the critical path.
 *
 * Flow (matches OpenSea/Zora — no intermediate app screen): click "Continue
 * with a wallet" → RainbowKit picker → on connect we IMMEDIATELY request the
 * SIWE signature (the wallet's own prompt pops straight away) → POST it → land
 * the session. We deliberately do NOT use RainbowKit's authentication adapter:
 * that inserts a "Sign in / Send message" confirmation screen between connect
 * and the wallet prompt — an extra click. Here the connect flows straight into
 * the signature.
 *
 * The signature is only auto-requested when the visitor CLICKED the button
 * (`wantSign`): wagmi silently reconnects a previously-used wallet on page load,
 * and firing a signature prompt unprompted would be hostile.
 *
 * Why the button is a real ConnectButton.Custom (not a plain button calling
 * openConnectModal): RainbowKit only opens its modal from a user gesture — a
 * programmatic openConnectModal() from an effect is a silent no-op.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { WagmiProvider, useAccount, useSignMessage, useDisconnect } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RainbowKitProvider,
  ConnectButton,
  useConnectModal,
} from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { SiweMessage } from "siwe";
import { useRouter } from "next/navigation";
import { Wallet } from "lucide-react";
import { getWagmiConfig } from "@/lib/wagmi-config";

// Mirrors server activeChainId() (web/lib/payment-tokens.ts). We stamp the SIWE
// message with the APP's chain, not the wallet's connected chain, so it always
// matches the server's activeChainId() gate (chainId is a message field, not a
// signed-over network binding). Base mainnet 8453 / Sepolia 84532.
const CHAIN_ID =
  process.env.NEXT_PUBLIC_AINDRIVE_PAYMENT_NETWORK === "mainnet" ? 8453 : 84532;

/** `next`: where to land after a successful sign-in (already same-origin-validated). */
export default function WalletLoginButton({ next }: { next: string }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={getWagmiConfig()}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>
          <WalletButton next={next} />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

function WalletButton({ next }: { next: string }) {
  const { openConnectModal, connectModalOpen } = useConnectModal();
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { disconnect } = useDisconnect();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True only between a button click and the signature completing — gates the
  // auto-sign effect so a page-load reconnect never pops a prompt on its own.
  const wantSign = useRef(false);

  const signIn = useCallback(
    async (addr: string) => {
      setBusy(true);
      setError(null);
      try {
        const nonceRes = await fetch("/api/wallet/nonce", { method: "POST" });
        if (!nonceRes.ok) throw new Error("could not start sign-in");
        const { nonce } = await nonceRes.json();

        const message = new SiweMessage({
          domain: window.location.host,
          address: addr,
          statement: "aindrive wants you to sign in with your wallet.",
          uri: window.location.origin,
          version: "1",
          chainId: CHAIN_ID,
          nonce,
        }).prepareMessage();

        // The wallet's own signature prompt — this is the one step the user sees.
        const signature = await signMessageAsync({ message });

        const r = await fetch("/api/wallet/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address: addr, signature, nonce, message }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          const msg =
            r.status === 403 && body.error === "wallet_login_not_enabled"
              ? "This wallet is linked to an email account — sign in with email, or enable wallet sign-in from settings."
              : body.error || "sign-in failed";
          setError(msg);
          // Drop the wallet so a retry re-opens the picker (the wagmi config is a
          // module singleton — a still-connected rejected wallet would otherwise
          // be reused straight away).
          disconnect();
          return;
        }
        router.push(next);
      } catch (e) {
        // Covers a user-rejected signature and network failures alike.
        const m = (e as Error)?.message || "";
        setError(/reject|denied|cancel/i.test(m) ? "Signature canceled." : "Could not sign in — try again.");
        disconnect();
      } finally {
        setBusy(false);
        wantSign.current = false;
      }
    },
    [signMessageAsync, disconnect, router, next],
  );

  // Auto-sign the moment an INTENTFUL connect lands (button was clicked). Never
  // fires on a bare page-load reconnect, where wantSign stays false.
  useEffect(() => {
    if (wantSign.current && isConnected && address && !busy) {
      wantSign.current = false;
      signIn(address);
    }
  }, [isConnected, address, busy, signIn]);

  function onClick() {
    setError(null);
    if (busy) return;
    if (isConnected && address) {
      // Already connected (e.g. reconnected on load) → go straight to signing.
      signIn(address);
    } else {
      wantSign.current = true;
      openConnectModal?.();
    }
  }

  return (
    <ConnectButton.Custom>
      {({ mounted }) => (
        <>
          <button
            type="button"
            disabled={!mounted || busy || connectModalOpen}
            onClick={onClick}
            className="mt-4 w-full flex items-center justify-center gap-2 rounded-lg border border-drive-border py-2 font-medium hover:bg-drive-hover disabled:opacity-60"
          >
            <Wallet className="w-4 h-4" />
            {busy ? "Signing in…" : "Continue with a wallet"}
          </button>
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        </>
      )}
    </ConnectButton.Custom>
  );
}
