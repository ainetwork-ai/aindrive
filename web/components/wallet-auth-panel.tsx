"use client";

/**
 * The heavy wallet sign-in flow, isolated so it can be `next/dynamic`-imported
 * only when a visitor actually chooses "Continue with a wallet" — the wagmi +
 * RainbowKit + WalletConnect stack (~300-600KB) never ships to email-only
 * users on first paint (the whole reason wallet sign-in used to live on its
 * own /login/wallet route; now it's one prominent button on /login instead).
 *
 * One-intent flow (matches OpenSea/Privy/Dynamic): mounting auto-opens the
 * wallet picker, and RainbowKit's authentication adapter chains straight into
 * the SIWE "Sign message" step inside the same modal — there is NO separate
 * "sign in" button. `status` drives that gate: it holds on the signature step
 * while 'unauthenticated' and only lands the session once our backend `verify`
 * flips it to 'authenticated'.
 *
 * The panel owns the whole wallet interaction (errors, retry, cancel) because
 * the wagmi connection lives in a module-level singleton (lib/wagmi-config):
 * every teardown path must `disconnect()` first, or a re-open would silently
 * reuse the same wallet and skip the picker. So the parent only mounts/unmounts
 * us and gets an onCancel to restore its button.
 */

import { useState, useMemo, useEffect, useRef } from "react";
import { WagmiProvider, useAccount, useDisconnect } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RainbowKitProvider,
  RainbowKitAuthenticationProvider,
  createAuthenticationAdapter,
  useConnectModal,
  type AuthenticationStatus,
} from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { SiweMessage } from "siwe";
import { useRouter } from "next/navigation";
import { getWagmiConfig } from "@/lib/wagmi-config";

// Mirrors server activeChainId() (web/lib/payment-tokens.ts). We stamp the SIWE
// message with the APP's chain, not the wallet's connected chain, so it always
// matches the server's activeChainId() gate (chainId is a message field, not a
// signed-over network binding). Base mainnet 8453 / Sepolia 84532.
const CHAIN_ID =
  process.env.NEXT_PUBLIC_AINDRIVE_PAYMENT_NETWORK === "mainnet" ? 8453 : 84532;

type PanelProps = {
  /** Where to land after a successful sign-in (already same-origin-validated). */
  next: string;
  /** Visitor backed out without signing — parent restores the "wallet" button. */
  onCancel: () => void;
};

export default function WalletAuthPanel({ next, onCancel }: PanelProps) {
  const [queryClient] = useState(() => new QueryClient());
  const [status, setStatus] = useState<AuthenticationStatus>("unauthenticated");
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const adapter = useMemo(
    () =>
      createAuthenticationAdapter<string>({
        getNonce: async () => {
          const r = await fetch("/api/wallet/nonce", { method: "POST" });
          if (!r.ok) throw new Error("could not get nonce");
          return (await r.json()).nonce;
        },
        createMessage: ({ nonce, address }) =>
          new SiweMessage({
            domain: window.location.host,
            address,
            statement: "aindrive wants you to sign in with your wallet.",
            uri: window.location.origin,
            version: "1",
            chainId: CHAIN_ID,
            nonce,
          }).prepareMessage(),
        verify: async ({ message, signature }) => {
          setStatus("loading");
          setError(null);
          try {
            // verify() only receives {message, signature}; our endpoint also
            // wants address + nonce, both carried inside the SIWE message.
            const parsed = new SiweMessage(message);
            const r = await fetch("/api/wallet/login", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                address: parsed.address,
                signature,
                nonce: parsed.nonce,
                message,
              }),
            });
            if (!r.ok) {
              const body = await r.json().catch(() => ({}));
              setError(
                r.status === 403 && body.error === "wallet_login_not_enabled"
                  ? "This wallet is linked to an email account — sign in with email, or enable wallet sign-in from settings."
                  : body.error || "sign-in failed",
              );
              setStatus("unauthenticated");
              return false;
            }
            setStatus("authenticated");
            return true;
          } catch {
            // Network/parse failure: without this catch the exception escapes
            // before either setStatus branch, stranding status at "loading"
            // (RainbowKit hides its modal, leaving the user stuck forever).
            setError("Couldn’t reach the server — check your connection and try again.");
            setStatus("unauthenticated");
            return false;
          }
        },
        signOut: async () => {
          await fetch("/api/auth/logout", { method: "POST" });
        },
      }),
    [],
  );

  // Land the session once the backend confirmed the signature.
  useEffect(() => {
    if (status === "authenticated") router.push(next);
  }, [status, next, router]);

  return (
    <WagmiProvider config={getWagmiConfig()}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitAuthenticationProvider adapter={adapter} status={status}>
          <RainbowKitProvider>
            <AuthFlow
              status={status}
              error={error}
              clearError={() => setError(null)}
              onCancel={onCancel}
            />
          </RainbowKitProvider>
        </RainbowKitAuthenticationProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

/**
 * Drives the modal from inside the provider tree: opens the wallet picker on
 * mount, detects a back-out, and gives explicit escapes for the two states the
 * modal alone leaves the user stuck in — a rejected wallet (offer a different
 * one) and a dismissed signature step (offer resume). Every escape disconnects
 * first so the shared wagmi client is clean for the next attempt.
 */
function AuthFlow({
  status,
  error,
  clearError,
  onCancel,
}: {
  status: AuthenticationStatus;
  error: string | null;
  clearError: () => void;
  onCancel: () => void;
}) {
  const { openConnectModal, connectModalOpen } = useConnectModal();
  const { isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const opened = useRef(false);
  const sawOpen = useRef(false);

  // Auto-open the picker as soon as RainbowKit is ready.
  useEffect(() => {
    if (!opened.current && openConnectModal) {
      opened.current = true;
      openConnectModal();
    }
  }, [openConnectModal]);

  // Back-out: the picker was open, is now closed, and no wallet ever connected
  // (and no error is pending) → the visitor dismissed it. Restore the button.
  useEffect(() => {
    if (connectModalOpen) {
      sawOpen.current = true;
      return;
    }
    if (sawOpen.current && opened.current && !isConnected && status === "unauthenticated" && !error) {
      onCancel();
    }
  }, [connectModalOpen, isConnected, status, error, onCancel]);

  // Leave for good — drop the wallet so a fresh click re-opens the picker.
  function cancel() {
    disconnect();
    onCancel();
  }
  // Rejected wallet → disconnect and reopen straight on the picker screen.
  function tryAnotherWallet() {
    disconnect();
    clearError();
    sawOpen.current = false;
    openConnectModal?.();
  }

  if (error) {
    return (
      <div className="mt-4 text-center text-sm">
        <p className="text-red-600">{error}</p>
        <div className="mt-3 flex items-center justify-center gap-2">
          <button
            onClick={tryAnotherWallet}
            className="rounded-lg border border-drive-border px-4 py-2 hover:bg-drive-hover"
          >
            Try a different wallet
          </button>
          <button onClick={cancel} className="px-4 py-2 text-drive-muted hover:text-drive-text">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // Connected but the signature step was dismissed: offer an explicit resume
  // (re-opening the modal drops the still-unauthenticated wallet back on the
  // "Sign message" step) rather than silently stalling.
  if (isConnected && status !== "authenticated" && !connectModalOpen) {
    return (
      <div className="mt-4 text-center text-sm">
        <p className="text-drive-muted">Almost there — approve the signature in your wallet.</p>
        <div className="mt-3 flex items-center justify-center gap-2">
          <button
            onClick={() => openConnectModal?.()}
            className="rounded-lg border border-drive-border px-4 py-2 hover:bg-drive-hover"
          >
            Resume sign-in
          </button>
          <button onClick={cancel} className="px-4 py-2 text-drive-muted hover:text-drive-text">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <p className="mt-4 text-center text-sm text-drive-muted">Opening your wallet…</p>
  );
}
