import { WalletProvider } from "@/components/wallet-provider";

/**
 * Adding a wallet to your account needs the web3 stack (wagmi + RainbowKit), so
 * it gets its own route + provider — same isolation as app/s/[token] (paywall)
 * and /login's code-split wallet panel: the ~300-600KB bundle stays off every
 * other page. The root layout deliberately omits WalletProvider.
 */
export default function AccountWalletLayout({ children }: { children: React.ReactNode }) {
  return <WalletProvider>{children}</WalletProvider>;
}
