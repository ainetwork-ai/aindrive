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
//   1. We want Base front-and-centre, and BOTH current Base entries explicit:
//      `baseAccount` (Sign in with Base — passkey Smart Wallet via the Base
//      Account SDK; the official successor connector, RainbowKit deprecated
//      `coinbaseWallet` in 2.2.9) plus legacy `coinbaseWallet` for the old
//      extension/app, per Base's migration guidance ("add a Base button next
//      to Coinbase Wallet, don't replace it"). `okxWallet` is explicit too:
//      with several extensions installed, the generic injected connector is a
//      window.ethereum roulette — requests can land in a wallet whose popup
//      the user never sees (reported as "pay popup never appears").
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
    // Order the chain list so the payment network is FIRST (wagmi's default
    // chain). Both are registered + given transports — the token policy decides
    // which one payments actually quote/settle on; this just makes the wallet
    // default to the right one.
    const chains = paymentNetwork() === "mainnet"
      ? ([base, baseSepolia] as const)
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
