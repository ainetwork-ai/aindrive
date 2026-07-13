import { WalletProvider } from "@/components/wallet-provider";

/**
 * Wallet sign-in gets its OWN route so the heavy web3 stack (wagmi + RainbowKit
 * + WalletConnect, ~300-600KB) stays scoped here — off the bundle-light /login
 * email form and every other route (the root layout deliberately omits
 * WalletProvider). Only a visitor who chooses "sign in with a wallet" and
 * navigates here pays that cost. Mirrors app/s/[token]/layout.tsx.
 */
export default function WalletLoginLayout({ children }: { children: React.ReactNode }) {
  return <WalletProvider>{children}</WalletProvider>;
}
