import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { baseAccount, walletConnectWallet } from "@rainbow-me/rainbowkit/wallets";
import { http, createConfig } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { paymentNetwork } from "./payment-tokens";
import { installEip6963UuidGuard } from "./eip6963-uuid-guard";

// We hand-roll the wallet list (instead of getDefaultConfig) for two reasons:
//   1. ONE flat, wallet-neutral group (product rule: wallet login must not
//      weight any vendor — no dedicated group or promotional label for Base;
//      see wallet-auth-panel.tsx). `baseAccount` keeps RainbowKit's default
//      "Base" name; the separate `coinbaseWallet` connector (deeplink to the
//      installed Coinbase Wallet / Base App) stays DROPPED as a confusing
//      duplicate. Payment gas sponsorship does not depend on connector
//      listing — it's capability-probed at pay time (share-gate).
//
//      We list ONLY `baseAccount` + `walletConnectWallet` explicitly. Every
//      INSTALLED browser wallet (MetaMask, OKX, Brave, Rainbow ext, …) is
//      surfaced automatically under "Installed" via EIP-6963 discovery, so
//      naming those wallets explicitly too (okxWallet/metaMaskWallet/
//      injectedWallet/…) makes each show TWICE — once as the named connector,
//      once as its 6963 announcement. baseAccount (a passkey, not a 6963
//      extension) and walletConnectWallet (mobile QR, no 6963) are the only two
//      6963 can't surface, so they're the only two we add by hand.
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
    // Must run before createConfig(): rewrites misbehaving EIP-6963 announces
    // (per-announce uuids -> duplicate "Installed" entries) — see eip6963-uuid-guard.ts.
    installEip6963UuidGuard();
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
    // Installed extensions come from EIP-6963 automatically; only the two
    // wallets 6963 can't surface are listed — see the header note on duplicates.
    const connectors = connectorsForWallets(
      [
        { groupName: "Wallets", wallets: [baseAccount, walletConnectWallet] },
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
