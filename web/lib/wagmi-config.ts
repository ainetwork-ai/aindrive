import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { baseSepolia } from "wagmi/chains";

export const wagmiConfig = getDefaultConfig({
  appName: "aindrive",
  projectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID || "aindrive-dev",
  chains: [baseSepolia],
  ssr: true,
});
