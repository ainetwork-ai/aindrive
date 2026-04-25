"use client";

import { useEffect, useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { wagmiConfig } from "@/lib/wagmi-config";

export function WalletProvider({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const [queryClient] = useState(() => new QueryClient());
  useEffect(() => setMounted(true), []);
  if (!mounted) return <>{children}</>;
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>{children}</RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
