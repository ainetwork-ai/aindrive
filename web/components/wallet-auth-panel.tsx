"use client";

/**
 * The heavy wallet sign-in control, isolated so it can be `next/dynamic`-imported
 * (ssr:false) off the email form: the wagmi + RainbowKit + WalletConnect stack
 * (~300-600KB) loads after first paint, not on the critical path.
 *
 * One-intent flow (matches OpenSea/Privy/Dynamic): our "Continue with a wallet"
 * button IS RainbowKit's ConnectButton (via ConnectButton.Custom), so its click
 * opens the wallet picker, and the authentication adapter chains straight into
 * the SIWE "Sign message" step inside the same modal — no separate "sign in"
 * button. `status` drives that gate: it holds on the signature step while
 * 'unauthenticated' and only lands the session once our backend `verify` flips
 * it to 'authenticated'.
 *
 * Why a real ConnectButton and not a programmatic openConnectModal(): RainbowKit
 * only opens the modal from a user gesture — calling openConnectModal() from a
 * mount effect is a silent no-op (connectModalOpen never flips). The click must
 * originate the open, which is exactly what ConnectButton.Custom wires up.
 */

import { useState, useMemo, useEffect } from "react";
import { WagmiProvider, useAccount, useDisconnect } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RainbowKitProvider,
  RainbowKitAuthenticationProvider,
  createAuthenticationAdapter,
  ConnectButton,
  type AuthenticationStatus,
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

/** Where to land after a successful sign-in (already same-origin-validated). */
export default function WalletLoginButton({ next }: { next: string }) {
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
            // before either setStatus branch, stranding status at "loading".
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
            <WalletButton error={error} clearError={() => setError(null)} />
          </RainbowKitProvider>
        </RainbowKitAuthenticationProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

/** The visible button, inside the provider tree so the click can open the modal. */
function WalletButton({ error, clearError }: { error: string | null; clearError: () => void }) {
  const { disconnect } = useDisconnect();
  const { isConnected } = useAccount();

  // A rejected sign-in (e.g. wallet linked to an email account) leaves the wallet
  // connected in the module-level wagmi singleton; without dropping it, the next
  // click would re-open straight on the same wallet's sign step and loop. Drop it
  // so a retry genuinely re-shows the picker for a different wallet.
  useEffect(() => {
    if (error && isConnected) disconnect();
  }, [error, isConnected, disconnect]);

  return (
    <ConnectButton.Custom>
      {({ openConnectModal, connectModalOpen, mounted }) => (
        <>
          <button
            type="button"
            disabled={!mounted || connectModalOpen}
            onClick={() => {
              clearError();
              openConnectModal();
            }}
            className="mt-4 w-full flex items-center justify-center gap-2 rounded-lg border border-drive-border py-2 font-medium hover:bg-drive-hover disabled:opacity-60"
          >
            <Wallet className="w-4 h-4" />
            {connectModalOpen ? "Opening wallet…" : "Continue with a wallet"}
          </button>
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        </>
      )}
    </ConnectButton.Custom>
  );
}
