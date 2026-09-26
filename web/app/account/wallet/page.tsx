"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useDisconnect } from "wagmi";
import { useWalletLink } from "@/components/use-wallet-link";

// Add a wallet as a second sign-in credential to the CURRENT (logged-in) account, and make it the
// payout wallet for drives that have none (POST /api/wallet/link { enableLogin: true } → login_enabled=1,
// lib/drives adoptOwnerPayoutWallet). Reached from the app's Account sheet and the web landing.
// One button: it connects a wallet if none is connected, then asks it to sign.
export default function AccountWalletPage() {
  const { link, busy, error, isConnected, address } = useWalletLink();
  const { openConnectModal, connectModalOpen } = useConnectModal();
  const { disconnect } = useDisconnect();
  const [done, setDone] = useState<{ payoutDrives: number } | null>(null);
  const wantSign = useRef(false);

  async function sign() {
    const r = await link();
    if (r) setDone({ payoutDrives: typeof r === "object" ? r.payoutDrives : 0 });
  }

  function start() {
    if (isConnected) { void sign(); return; }
    wantSign.current = true;   // sign right after the wallet connects: one tap for the user
    openConnectModal?.();
  }

  useEffect(() => {
    if (wantSign.current && isConnected) { wantSign.current = false; void sign(); }
    if (!connectModalOpen && !isConnected) wantSign.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, connectModalOpen]);

  const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "";

  return (
    <main className="min-h-screen min-h-[100dvh] flex items-center justify-center px-6">
      <div className="w-full max-w-sm bg-white border border-drive-border rounded-2xl p-6 shadow-drive">
        {done ? (
          <>
            <h1 className="text-xl font-semibold">Wallet added</h1>
            <p className="mt-2 text-sm text-drive-muted">
              You can now sign in with <span className="font-mono">{short}</span>.
              {done.payoutDrives > 0
                ? ` It's also the payout wallet for ${done.payoutDrives} of your drive${done.payoutDrives === 1 ? "" : "s"}, so you can start selling.`
                : " Sales go to it on drives without a payout wallet."}
            </p>
            <p className="mt-4 text-sm text-drive-muted">If you came from the aindrive app, you can go back to it now.</p>
            <Link className="mt-5 block text-center rounded-lg bg-drive-accent text-white py-2 hover:bg-drive-accentHover" href="/">Back to your drives</Link>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold">Sign in with a wallet</h1>
            <p className="mt-1 text-sm text-drive-muted">
              Add a wallet to your account. You can then sign in with it, and sales from your drives are paid to it.
            </p>
            <button
              disabled={busy}
              onClick={start}
              className="mt-5 w-full rounded-lg bg-drive-accent text-white py-2.5 font-medium hover:bg-drive-accentHover disabled:opacity-60"
            >
              {busy ? "Check your wallet…" : isConnected ? `Add ${short}` : "Connect wallet"}
            </button>
            {isConnected && !busy && (
              <p className="mt-2 text-xs text-drive-muted text-center">
                Your wallet will ask you to sign a message — it's free and moves no money.{" "}
                <button className="text-drive-accent hover:underline" onClick={() => disconnect()}>Use a different wallet</button>
              </p>
            )}
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
