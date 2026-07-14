"use client";

import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { getWagmiConfig } from "@/lib/wagmi-config";

export function WalletProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  // reconnectOnMount={false}: this provider mounts on route load (/s/[token]
  // paywall, /account/wallet). With the default auto-reconnect, wagmi silently
  // reconnects the last-used wallet on landing, and the Base Account connector
  // pops its keys.coinbase.com window on reconnect — without a user gesture the
  // browser blocks it and strands a "Try again" modal (seen when a logged-out
  // visitor hits a paid share and is redirected to /login). Nothing here needs
  // wallet state before the user acts: access checks are cookie-based, and
  // payment/link flows start from a click, which connects then.
  return (
    <WagmiProvider config={getWagmiConfig()} reconnectOnMount={false}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>{children}</RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
