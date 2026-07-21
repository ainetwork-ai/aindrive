"use client";

/**
 * The heavy wallet sign-in control, isolated so it can be `next/dynamic`-imported
 * (ssr:false) off the email form: the wagmi + RainbowKit + WalletConnect stack
 * (~300-600KB) loads after first paint, not on the critical path.
 *
 * ONE wallet-neutral entry point (product rule: wallet login must not weight
 * any vendor — Base is a market-share fact today, not a UI privilege): a
 * single "Sign in with a wallet" button opens the RainbowKit picker, and the
 * signing path is chosen by the CONNECTED connector, not by which button was
 * pressed:
 *
 * - Base Account (passkey) connector → `wallet_connect` + the
 *   `signInWithEthereum` capability: passkey auth AND the SIWE signature in
 *   ONE keys.coinbase.com popup. Requested right after connect, it rides the
 *   SDK popup's 200ms linger window; at worst the SDK shows its own retry
 *   dialog. (A connect→personal_sign flow would need a second popup with no
 *   user gesture left — desktop degrades, mobile Safari kills it.) See
 *   lib/base-siwe.ts for the request/response mapping. The nonce and the SDK
 *   provider are prefetched on mount so the post-connect path has no await
 *   before the capability request.
 *
 * - Everything else (EIP-6963 extensions, WalletConnect) → classic SIWE
 *   personal_sign; extensions prompt in-page, WC deep-links — no popup
 *   constraints.
 *
 * The signature is only auto-requested when the visitor CLICKED a button
 * (`wantSign`): wagmi silently reconnects a previously-used wallet on page load,
 * and firing a signature prompt unprompted would be hostile.
 *
 * Why the buttons live inside a real ConnectButton.Custom (not plain buttons
 * calling openConnectModal): RainbowKit only opens its modal from a user
 * gesture — a programmatic openConnectModal() from an effect is a silent no-op.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { WagmiProvider, useAccount, useSignMessage, useDisconnect, useConnect } from "wagmi";
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
import { walletConnectSiweRequest, extractSiweAuth } from "@/lib/base-siwe";

// Mirrors server activeChainId() (web/lib/payment-tokens.ts). We stamp the SIWE
// message with the APP's chain, not the wallet's connected chain, so it always
// matches the server's activeChainId() gate (chainId is a message field, not a
// signed-over network binding). Base mainnet 8453 / Sepolia 84532.
const CHAIN_ID =
  process.env.NEXT_PUBLIC_AINDRIVE_PAYMENT_NETWORK === "mainnet" ? 8453 : 84532;

// Refuse a prefetched nonce this close to expiry (server TTL 5 min): the popup
// round-trip + verify POST must complete before the server GCs it.
const NONCE_STALE_MARGIN_MS = 60_000;

/** `next`: where to land after a successful sign-in (already same-origin-validated). */
export default function WalletLoginButton({ next }: { next: string }) {
  const [queryClient] = useState(() => new QueryClient());
  // reconnectOnMount={false}: this control mounts on page load (so the button's
  // click can open the modal — RainbowKit only opens from a gesture). With the
  // default auto-reconnect, wagmi would silently reconnect a previously-used
  // wallet on load, and some connectors (Base Account passkey) pop their own UI
  // on reconnect — an unprompted keys.coinbase.com popup just from landing on
  // /login. A login page has no reason to restore wallet state before the user
  // clicks; they initiate the connect.
  return (
    <WagmiProvider config={getWagmiConfig()} reconnectOnMount={false}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>
          <WalletButtons next={next} />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

function WalletButtons({ next }: { next: string }) {
  const { openConnectModal, connectModalOpen } = useConnectModal();
  const { address, isConnected, connector: activeConnector } = useAccount();
  const { connectors } = useConnect();
  const { signMessageAsync } = useSignMessage();
  const { disconnect } = useDisconnect();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True only between a button click and the signature completing — gates the
  // auto-sign effect so a page-load reconnect never pops a prompt on its own.
  const wantSign = useRef(false);
  // Server-issued SIWE nonce, prefetched so the Base click path reaches the
  // popup with zero network awaits (mobile Safari drops the click's user
  // activation across slow awaits, and the popup then gets blocked).
  const nonceRef = useRef<{ nonce: string; expiresAt: number } | null>(null);

  const fetchNonce = useCallback(async () => {
    const res = await fetch("/api/wallet/nonce", { method: "POST" });
    if (!res.ok) throw new Error("could not start sign-in");
    return (await res.json()) as { nonce: string; expiresAt: number };
  }, []);

  // Consume the prefetched nonce if still fresh, else fetch inline (rare —
  // only when the visitor sat on /login past the TTL). Refill in the
  // background either way so a retry is fast again.
  const takeNonce = useCallback(async (): Promise<string> => {
    const held = nonceRef.current;
    nonceRef.current = null;
    const refill = () => {
      fetchNonce().then((n) => { nonceRef.current = n; }).catch(() => {});
    };
    if (held && held.expiresAt - Date.now() > NONCE_STALE_MARGIN_MS) {
      refill();
      return held.nonce;
    }
    const fresh = await fetchNonce();
    refill();
    return fresh.nonce;
  }, [fetchNonce]);

  // Prefetch the nonce and warm the Base SDK (its provider is created via a
  // dynamic import — loading that chunk during the click would also burn the
  // gesture). Fire-and-forget: failures fall back to inline fetch on click.
  useEffect(() => {
    fetchNonce().then((n) => { nonceRef.current = n; }).catch(() => {});
    connectors.find((c) => c.id === "baseAccount")?.getProvider().catch(() => {});
  }, [fetchNonce, connectors]);

  /** POST the SIWE proof; on success land the session, on failure explain. */
  const submitLogin = useCallback(
    async (body: { address: string; signature: string; nonce: string; message: string }): Promise<boolean> => {
      const r = await fetch("/api/wallet/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const resBody = await r.json().catch(() => ({}));
        const msg =
          r.status === 403 && resBody.error === "wallet_login_not_enabled"
            ? "This wallet is linked to an email account — sign in with email, or enable wallet sign-in from settings."
            : resBody.error || "sign-in failed";
        setError(msg);
        return false;
      }
      router.push(next);
      return true;
    },
    [router, next],
  );

  // Base Account sign-in: ONE wallet_connect request carries the
  // signInWithEthereum capability, so a single SDK popup covers passkey auth
  // + SIWE signature. Invoked right after a picker connect (rides the popup's
  // 200ms linger window) or on a retry click while still connected.
  const baseSiweLogin = useCallback(async () => {
    const baseConnector = connectors.find((c) => c.id === "baseAccount");
    if (!baseConnector) {
      setError("Base sign-in is unavailable — try another wallet.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const nonce = await takeNonce();
      const provider = (await baseConnector.getProvider()) as {
        request: (args: unknown) => Promise<unknown>;
      };
      const result = await provider.request(walletConnectSiweRequest(nonce, CHAIN_ID));
      const auth = extractSiweAuth(result);
      const ok = await submitLogin({ ...auth, nonce });
      // Mirror personalSignLogin: drop a modal-connected Base wallet on failure
      // so the next button click re-opens the picker instead of being routed
      // straight back to Base.
      if (!ok) disconnect();
    } catch (e) {
      const m = (e as Error)?.message || "";
      if (/blocked/i.test(m)) {
        setError("Your browser blocked the sign-in window — tap the button again.");
      } else if (/reject|denied|cancel|closed/i.test(m)) {
        setError("Sign-in canceled.");
      } else {
        setError("Could not sign in — try again.");
      }
      disconnect();
    } finally {
      setBusy(false);
      wantSign.current = false;
    }
  }, [connectors, takeNonce, submitLogin, disconnect]);

  // Non-Base wallets (extensions, WalletConnect): classic SIWE personal_sign.
  // Extensions prompt in-page and WalletConnect deep-links, so the no-gesture
  // effect context is fine here — only the Base popup needs the capability path.
  const personalSignLogin = useCallback(
    async (addr: string) => {
      setBusy(true);
      setError(null);
      try {
        const nonce = await takeNonce();
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

        const ok = await submitLogin({ address: addr, signature, nonce, message });
        // Drop the wallet so a retry re-opens the picker (the wagmi config is a
        // module singleton — a still-connected rejected wallet would otherwise
        // be reused straight away).
        if (!ok) disconnect();
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
    [takeNonce, signMessageAsync, submitLogin, disconnect],
  );

  // Auto-sign the moment an INTENTFUL connect lands (button was clicked). Never
  // fires on a bare page-load reconnect, where wantSign stays false.
  useEffect(() => {
    if (wantSign.current && isConnected && address && !busy) {
      wantSign.current = false;
      if (activeConnector?.id === "baseAccount") baseSiweLogin();
      else personalSignLogin(address);
    }
  }, [isConnected, address, busy, activeConnector, baseSiweLogin, personalSignLogin]);

  function onWalletClick() {
    setError(null);
    if (busy) return;
    if (isConnected && address) {
      // Already connected (e.g. picked a wallet, then canceled the signature)
      // → go straight to signing with that wallet.
      if (activeConnector?.id === "baseAccount") baseSiweLogin();
      else personalSignLogin(address);
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
            onClick={onWalletClick}
            className="mt-4 w-full flex items-center justify-center gap-2 rounded-lg border border-drive-border py-2 font-medium hover:bg-drive-hover disabled:opacity-60"
          >
            <Wallet className="w-4 h-4" />
            {busy ? "Signing in…" : "Sign in with a wallet"}
          </button>
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        </>
      )}
    </ConnectButton.Custom>
  );
}
