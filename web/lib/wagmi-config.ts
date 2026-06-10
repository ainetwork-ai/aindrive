import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  injectedWallet,
  metaMaskWallet,
  rainbowWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { http, createConfig } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { paymentNetwork } from "./payment-tokens";

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
// Chain follows the single payment-network switch (NEXT_PUBLIC_AINDRIVE_PAYMENT_
// NETWORK, via paymentNetwork()) so the wallet's chain and the token policy's
// chain (lib/payment-tokens.ts) can never disagree. Default testnet.
type WagmiConfig = ReturnType<typeof createConfig>;
let _config: WagmiConfig | null = null;

export function getWagmiConfig(): WagmiConfig {
  if (!_config) {
    const projectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID || "aindrive-dev";
    // Order the chain list so the payment network is FIRST (wagmi's default
    // chain). Both are registered + given transports — the token policy decides
    // which one payments actually quote/settle on; this just makes the wallet
    // default to the right one.
    const chains = paymentNetwork() === "mainnet"
      ? ([base, baseSepolia] as const)
      : ([baseSepolia, base] as const);
    const connectors = connectorsForWallets(
      [
        { groupName: "Base", wallets: [coinbaseWallet] },
        { groupName: "Other wallets", wallets: [injectedWallet, metaMaskWallet, rainbowWallet, walletConnectWallet] },
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
