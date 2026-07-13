"use client";
import Link from "next/link";
import dynamic from "next/dynamic";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Wallet } from "lucide-react";

// The wallet stack (wagmi + RainbowKit, ~300-600KB) is code-split behind this
// dynamic import and only fetched when a visitor clicks "Continue with a
// wallet" — email sign-in stays on the light bundle. ssr:false because the
// wagmi provider tree is client-only.
const WalletAuthPanel = dynamic(() => import("@/components/wallet-auth-panel"), {
  ssr: false,
  loading: () => (
    <p className="mt-4 text-center text-sm text-drive-muted">Loading wallet…</p>
  ),
});

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const next = search.get("next");
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Wallet sign-in is opt-in per visit: mounting WalletAuthPanel pulls the heavy
  // web3 bundle and auto-opens the picker, so we only do it on an explicit click.
  // The panel owns its own errors/retry; we just show or hide it.
  const [walletMode, setWalletMode] = useState(false);

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
        <input name="email" type="email" required className="mt-1 w-full rounded-lg border border-drive-border px-3 py-2" />
      </label>
      <label className="block mt-3 text-sm">Password
        <input name="password" type="password" required className="mt-1 w-full rounded-lg border border-drive-border px-3 py-2" />
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

      {walletMode ? (
        <WalletAuthPanel next={safeNext} onCancel={() => setWalletMode(false)} />
      ) : (
        <button
          type="button"
          onClick={() => setWalletMode(true)}
          className="mt-4 w-full flex items-center justify-center gap-2 rounded-lg border border-drive-border py-2 font-medium hover:bg-drive-hover"
        >
          <Wallet className="w-4 h-4" />
          Continue with a wallet
        </button>
      )}

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
