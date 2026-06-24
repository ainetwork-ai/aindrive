import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  baseAccount,
  injectedWallet,
  metaMaskWallet,
  okxWallet,
  rainbowWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { http, createConfig } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { paymentNetwork } from "./payment-tokens";

// We hand-roll the wallet list (instead of getDefaultConfig) for two reasons:
//   1. Base front-and-centre via `baseAccount` (Sign in with Base) = the passkey
//      Smart Wallet through keys.coinbase.com — no app install required. We
//      deliberately DROPPED the separate `coinbaseWallet` connector (the
//      Coinbase Wallet SDK that deeplinks to the installed Coinbase Wallet /
//      Base App): keeping both read as confusing duplicates to buyers, so we
//      keep only the passkey path here. Users who want an installed wallet app
//      still reach it via `walletConnectWallet` (WC) or an EIP-6963 injected
//      extension (auto-listed under "Installed"); `okxWallet`/`metaMaskWallet`/
//      `rainbowWallet`/`injectedWallet` stay per RainbowKit's broad support.
//   2. getDefaultConfig instantiates connectors at module load. Some of them
//      touch `window`/`localStorage` during construction, which crashes SSR
//      with "ReferenceError: window is not defined" the moment any server
//      component imports a client component that transitively imports this
//      file. Defer construction until the first browser access.
//
// Chain follows the single payment-network switch (NEXT_PUBLIC_AINDRIVE_PAYMENT_
// NETWORK, via paymentNetwork()) so the wallet's chain and the token policy's
// chain (lib/payment-tokens.ts) can never disagree. Default testnet.
type WagmiConfig = ReturnType<typeof createConfig>;
let _config: WagmiConfig | null = null;

export function getWagmiConfig(): WagmiConfig {
  if (!_config) {
    const projectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID || "aindrive-dev";
    if (!process.env.NEXT_PUBLIC_WC_PROJECT_ID) {
      // The placeholder keeps extension flows working, but WalletConnect
      // relay flows (mobile wallets / QR — e.g. Base App on a phone pairing
      // with a desktop browser) need a real project id from cloud.reown.com.
      console.warn("[aindrive] NEXT_PUBLIC_WC_PROJECT_ID is not set — WalletConnect/mobile QR pairing will fail");
    }
    // Register ONLY the chains a payment can actually be on for this
    // deployment. RainbowKit auto-renders a network switcher for every
    // registered chain, so registering both leaked a pointless "Base /
    // Base Sepolia" chooser to buyers. A mainnet deployment settles only on
    // Base (the token-policy chain guard rejects testnet tokens — see
    // payment-tokens.ts policyChainViolation), so register Base alone and the
    // switcher disappears. A testnet/dev deployment deliberately allows tokens
    // on EITHER chain (so dev can exercise real mainnet tokens locally), so it
    // registers both. First entry is wagmi's default chain.
    const chains = paymentNetwork() === "mainnet"
      ? ([base] as const)
      : ([baseSepolia, base] as const);
    // Clearer label: RainbowKit's default name for baseAccount reads opaque to
    // non-crypto buyers, so override ONLY the display name + shortName (connector
    // logic, icon, preferences untouched — the creator reads its own static
    // config off the original function, so wrapping the call is safe).
    const relabel = <W extends (...args: never[]) => { name: string; shortName?: string }>(
      wallet: W, name: string, shortName: string,
    ): W => ((...args: Parameters<W>) => ({ ...wallet(...args), name, shortName })) as W;
    const connectors = connectorsForWallets(
      [
        { groupName: "Base", wallets: [
          relabel(baseAccount, "Sign in with Base (passkey)", "Base"),
        ] },
        { groupName: "Other wallets", wallets: [okxWallet, metaMaskWallet, rainbowWallet, walletConnectWallet, injectedWallet] },
      ],
      { appName: "aindrive", projectId },
    );
    _config = createConfig({
      chains,
      connectors,
      transports: { [base.id]: http(), [baseSepolia.id]: http() },
      ssr: true,
    });
  }
  return _config;
}
