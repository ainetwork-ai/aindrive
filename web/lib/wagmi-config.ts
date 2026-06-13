import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  baseAccount,
  coinbaseWallet,
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
//   1. Base front-and-centre with BOTH Coinbase connectors, because they cover
//      DIFFERENT transports (verified against Base's docs):
//      - `baseAccount` (Sign in with Base) = passkey Smart Wallet via
//        keys.coinbase.com. Great on desktop, but it does NOT deeplink to an
//        installed mobile app — on mobile with no passkey it dead-ends at
//        "try again".
//      - `coinbaseWallet` (Coinbase Wallet SDK, Base's "legacy SDK access")
//        IS the path that opens the installed Coinbase Wallet / Base mobile
//        APP via a deeplink. Coinbase/Base wallets connect through this SDK,
//        NOT WalletConnect, so they never appear in the WC list — without this
//        connector a mobile Base-App user has no working path. (An earlier
//        change dropped it as "deprecated"; that was right for desktop, where
//        EIP-6963 auto-lists the extension, but wrong for mobile.)
//      `okxWallet`, `injectedWallet`, `walletConnectWallet` stay per
//      RainbowKit's broad-support recommendation; installed EIP-6963 extensions
//      still auto-list under "Installed".
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
    const connectors = connectorsForWallets(
      [
        { groupName: "Base", wallets: [baseAccount, coinbaseWallet] },
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
