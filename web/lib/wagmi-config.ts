import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  injectedWallet,
  metaMaskWallet,
  rainbowWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { http, createConfig } from "wagmi";
import { baseSepolia } from "wagmi/chains";

// We hand-roll the wallet list (instead of getDefaultConfig) for two reasons:
//   1. We want Base front-and-centre: `coinbaseWallet` (Coinbase Wallet / Base
//      Account / Base App's Smart Wallet) leads the list. We deliberately use
//      `coinbaseWallet` and NOT rainbowkit's `baseAccount` wallet — the latter
//      eagerly probes Smart Wallet on every page load and pops "aindrive wants
//      to continue in Base Account". `coinbaseWallet` is click-to-connect (no
//      auto-probe) and still resolves to Base Account / Coinbase Wallet, so
//      Base users get a first-class option without the disruptive popup.
//      Other wallets stay available below for non-Base users.
//   2. getDefaultConfig instantiates connectors at module load. Some of them
//      touch `window`/`localStorage` during construction, which crashes SSR
//      with "ReferenceError: window is not defined" the moment any server
//      component imports a client component that transitively imports this
//      file. Defer construction until the first browser access.
//
// Chain: base-sepolia only for now — the drive token policy quotes USDC on
// base-sepolia (lib/payment-tokens.ts) and x402 settles there. Base mainnet +
// mainnet tokens is a production-switch follow-up (token presets + facilitator).
type WagmiConfig = ReturnType<typeof createConfig>;
let _config: WagmiConfig | null = null;

export function getWagmiConfig(): WagmiConfig {
  if (!_config) {
    const projectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID || "aindrive-dev";
    const connectors = connectorsForWallets(
      [
        { groupName: "Base", wallets: [coinbaseWallet] },
        { groupName: "Other wallets", wallets: [injectedWallet, metaMaskWallet, rainbowWallet, walletConnectWallet] },
      ],
      { appName: "aindrive", projectId },
    );
    _config = createConfig({
      chains: [baseSepolia],
      connectors,
      transports: { [baseSepolia.id]: http() },
      ssr: true,
    });
  }
  return _config;
}
