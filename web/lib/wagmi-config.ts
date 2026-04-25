import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  injectedWallet,
  metaMaskWallet,
  rainbowWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { http, createConfig } from "wagmi";
import { baseSepolia } from "wagmi/chains";

// We hand-roll the wallet list (instead of getDefaultConfig) for two reasons:
//   1. Rainbowkit's default list includes `baseAccount`, which probes Coinbase
//      Smart Wallet on every page load and pops "aindrive wants to continue
//      in Base Account" — disruptive for users who don't have it.
//   2. getDefaultConfig instantiates connectors at module load. Some of them
//      touch `window`/`localStorage` during construction, which crashes SSR
//      with "ReferenceError: window is not defined" the moment any server
//      component imports a client component that transitively imports this
//      file. Defer construction until the first browser access.
type WagmiConfig = ReturnType<typeof createConfig>;
let _config: WagmiConfig | null = null;

export function getWagmiConfig(): WagmiConfig {
  if (!_config) {
    const projectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID || "aindrive-dev";
    const connectors = connectorsForWallets(
      [
        {
          groupName: "Recommended",
          wallets: [injectedWallet, metaMaskWallet, rainbowWallet, walletConnectWallet],
        },
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
