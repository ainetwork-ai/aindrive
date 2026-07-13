"use client";
import Link from "next/link";
import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useWalletSession } from "@/components/use-wallet-session";

// Wallet-only sign-in page. Reached from /login ("sign in with a wallet
// instead") and, indirectly, from the free-share login gate — the path a
// wallet-only account (no email/password) needs to log in. SIWE → session via
// useWalletSession; on success continue to the `next` the visitor came from.
function WalletLoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const next = search.get("next");
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const { login, busy, error, isConnected } = useWalletSession();

  async function signIn() {
    const ok = await login();
    if (ok) router.push(safeNext);
  }

  return (
    <div className="w-full max-w-sm bg-white border border-drive-border rounded-2xl p-6 shadow-drive">
      <h1 className="text-xl font-semibold">Sign in with your wallet</h1>
      <p className="mt-1 text-sm text-drive-muted">
        No email needed — your wallet is your sign-in. There is no password recovery: lose the wallet and you lose access.
      </p>
      <div className="mt-5 flex justify-center">
        <ConnectButton showBalance={false} chainStatus="none" />
      </div>
      <button
        disabled={!isConnected || busy}
        onClick={signIn}
        className="mt-4 w-full rounded-lg bg-drive-accent text-white py-2 hover:bg-drive-accentHover disabled:opacity-60"
      >
        {busy ? "Signing in…" : isConnected ? "Sign in with wallet" : "Connect a wallet first"}
      </button>
      {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
      <p className="mt-4 text-sm text-drive-muted text-center">
        <Link
          className="text-drive-accent hover:underline"
          href={next ? `/login?next=${encodeURIComponent(next)}` : "/login"}
        >
          Use email instead
        </Link>
      </p>
    </div>
  );
}

export default function WalletLoginPage() {
  return (
    <main className="min-h-screen min-h-[100dvh] flex items-center justify-center px-6">
      <Suspense fallback={null}>
        <WalletLoginForm />
      </Suspense>
    </main>
  );
}
