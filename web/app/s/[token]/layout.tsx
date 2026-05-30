import { WalletProvider } from "@/components/wallet-provider";

/**
 * The share route is the ONLY place that needs the wallet stack (wagmi +
 * RainbowKit + WalletConnect): visitors connect a wallet to pay an x402
 * paywall or to re-prove access on a new device. Scoping WalletProvider to
 * this subtree (instead of the root layout) keeps the heavy web3 bundle off
 * every other route — landing, auth, and the main drive workspace.
 *
 * This is a server component that eagerly renders the client WalletProvider,
 * so the provider tree is mounted before ShareGate's dynamic(ssr:false) chunk
 * loads inside it — preserving provider-before-consumer ordering.
 */
export default function ShareLayout({ children }: { children: React.ReactNode }) {
  return <WalletProvider>{children}</WalletProvider>;
}
