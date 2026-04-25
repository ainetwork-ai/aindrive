import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { baseSepolia } from "wagmi/chains";

// getDefaultConfig instantiates wagmi connectors at module load. Some connectors
// (e.g. MetaMask SDK) touch `window`/`localStorage` during construction, which
// crashes SSR with "ReferenceError: window is not defined" the moment any server
// component imports a client component that transitively imports this file.
// Defer construction until the first browser access.
type WagmiConfig = ReturnType<typeof getDefaultConfig>;
let _config: WagmiConfig | null = null;

export function getWagmiConfig(): WagmiConfig {
  if (!_config) {
    _config = getDefaultConfig({
      appName: "aindrive",
      projectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID || "aindrive-dev",
      chains: [baseSepolia],
      ssr: true,
    });
  }
  return _config;
}
