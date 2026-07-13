"use client";
import Link from "next/link";
import { useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useWalletLink } from "@/components/use-wallet-link";

// Add a wallet as a second sign-in credential to the CURRENT (logged-in email)
// account. Reached from the landing ("Add wallet sign-in"). SIWE-signs while
// authenticated → /api/wallet/link { enableLogin: true } → login_enabled=1.
export default function AccountWalletPage() {
  const { link, busy, error, isConnected } = useWalletLink();
  const [done, setDone] = useState(false);

  async function addWallet() {
    const ok = await link();
    if (ok) setDone(true);
  }

  return (
    <main className="min-h-screen min-h-[100dvh] flex items-center justify-center px-6">
      <div className="w-full max-w-sm bg-white border border-drive-border rounded-2xl p-6 shadow-drive">
        <h1 className="text-xl font-semibold">Add a wallet sign-in</h1>
        <p className="mt-1 text-sm text-drive-muted">
          Link a wallet to your account so you can also sign in with it — in addition to your email and password.
        </p>
        {done ? (
          <p className="mt-5 text-sm text-drive-accent">
            Wallet added — you can now sign in with it too.{" "}
            <Link className="hover:underline" href="/">Back to your drives</Link>
          </p>
        ) : (
          <>
            <div className="mt-5 flex justify-center">
              <ConnectButton showBalance={false} chainStatus="none" />
            </div>
            <button
              disabled={!isConnected || busy}
              onClick={addWallet}
              className="mt-4 w-full rounded-lg bg-drive-accent text-white py-2 hover:bg-drive-accentHover disabled:opacity-60"
            >
              {busy ? "Adding…" : isConnected ? "Add wallet & enable sign-in" : "Connect a wallet first"}
            </button>
            {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
            <p className="mt-4 text-sm text-drive-muted text-center">
              <Link className="text-drive-accent hover:underline" href="/">Cancel</Link>
            </p>
          </>
        )}
      </div>
    </main>
  );
}
