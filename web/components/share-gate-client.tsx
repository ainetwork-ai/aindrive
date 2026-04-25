"use client";

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

// Defer ShareGate to client-only render. ShareGate uses wagmi hooks
// (`useAccount`, `useWalletClient`) which need a live `WagmiProvider`
// context. With ssr: true on the underlying config, SSR can still
// render WagmiProviderNotFoundError on this route, blowing up the
// whole `/s/[token]` page. Skipping SSR here gets us a clean
// hydration with the provider tree set up before ShareGate mounts.
export const ShareGate = dynamic(
  () => import("./share-gate").then((m) => ({ default: m.ShareGate })),
  {
    ssr: false,
    loading: () => (
      <div className="min-h-screen min-h-[100dvh] flex items-center justify-center text-drive-muted gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        loading…
      </div>
    ),
  },
);
