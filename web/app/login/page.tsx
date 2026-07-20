"use client";
import Link from "next/link";
import dynamic from "next/dynamic";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Wallet, KeyRound } from "lucide-react";

// The wallet stack (wagmi + RainbowKit, ~300-600KB) is code-split behind this
// dynamic import (ssr:false — the provider tree is client-only) so it loads
// AFTER first paint, off the email form's critical path. It mounts on page load
// (not gated behind a click) because RainbowKit only opens its modal from a user
// gesture: the button's own click must originate the open, so the provider has
// to already be mounted when the visitor clicks. Until the chunk arrives we show
// disabled buttons identical to the live control (no layout shift, no flash) —
// keep the markup in sync with wallet-auth-panel's rendered buttons.
const WalletLoginButton = dynamic(() => import("@/components/wallet-auth-panel"), {
  ssr: false,
  loading: () => (
    <>
      <button
        type="button"
        disabled
        className="mt-4 w-full flex items-center justify-center gap-2 rounded-lg border border-drive-border py-2 font-medium disabled:opacity-60"
      >
        <KeyRound className="w-4 h-4" />
        Sign in with Base (passkey)
      </button>
      <button
        type="button"
        disabled
        className="mt-2 w-full flex items-center justify-center gap-2 rounded-lg py-2 text-sm text-drive-muted disabled:opacity-60"
      >
        <Wallet className="w-4 h-4" />
        Other wallets
      </button>
    </>
  ),
});

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const next = search.get("next");
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true); setErr(null);
    const fd = new FormData(e.currentTarget);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: fd.get("email"), password: fd.get("password") }),
    });
    setLoading(false);
    if (!res.ok) { setErr((await res.json()).error || "login failed"); return; }
    router.push(safeNext);
  }
  return (
    <form onSubmit={onSubmit} className="w-full max-w-sm bg-white border border-drive-border rounded-2xl p-6 shadow-drive">
      <h1 className="text-xl font-semibold">Sign in</h1>
      <label className="block mt-5 text-sm">Email
        <input name="email" type="email" autoComplete="email" required className="mt-1 w-full rounded-lg border border-drive-border px-3 py-2" />
      </label>
      <label className="block mt-3 text-sm">Password
        <input name="password" type="password" autoComplete="current-password" required className="mt-1 w-full rounded-lg border border-drive-border px-3 py-2" />
      </label>
      <div className="mt-2 text-right">
        <Link href="/forgot-password" className="text-xs text-drive-muted hover:text-drive-accent hover:underline">
          Forgot your password?
        </Link>
      </div>
      {err && <p className="text-sm text-red-600 mt-3">{err}</p>}
      <button disabled={loading} className="mt-5 w-full rounded-lg bg-drive-accent text-white py-2 hover:bg-drive-accentHover disabled:opacity-60">
        {loading ? "Signing in…" : "Sign in"}
      </button>

      {/* ── or ── divider between the two identity paths (email above, wallet below) */}
      <div className="mt-6 flex items-center gap-3 text-xs text-drive-muted">
        <span className="h-px flex-1 bg-drive-border" />
        or
        <span className="h-px flex-1 bg-drive-border" />
      </div>

      <WalletLoginButton next={safeNext} />

      <p className="mt-5 text-sm text-drive-muted text-center">
        New here?{" "}
        <Link
          className="text-drive-accent hover:underline"
          href={next ? `/signup?next=${encodeURIComponent(next)}` : "/signup"}
        >
          Create an account
        </Link>
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="min-h-screen min-h-[100dvh] flex items-center justify-center px-6">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
