"use client";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function SignupForm() {
  const router = useRouter();
  const search = useSearchParams();
  const next = search.get("next");
  // Open-redirect guard: only same-origin paths ("/x"), never "//evil.com".
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true); setErr(null);
    const fd = new FormData(e.currentTarget);
    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: fd.get("email"),
        password: fd.get("password"),
        name: fd.get("name"),
      }),
    });
    setLoading(false);
    if (!res.ok) { setErr((await res.json()).error || "signup failed"); return; }
    router.push(safeNext);
  }
  return (
      <form onSubmit={onSubmit} className="w-full max-w-sm bg-white border border-drive-border rounded-2xl p-6 shadow-drive">
        <h1 className="text-xl font-semibold">Create your aindrive</h1>
        <label className="block mt-5 text-sm">Name
          <input name="name" required className="mt-1 w-full rounded-lg border border-drive-border px-3 py-2" />
        </label>
        <label className="block mt-3 text-sm">Email
          <input name="email" type="email" required className="mt-1 w-full rounded-lg border border-drive-border px-3 py-2" />
        </label>
        <label className="block mt-3 text-sm">Password
          <input name="password" type="password" minLength={8} required className="mt-1 w-full rounded-lg border border-drive-border px-3 py-2" />
        </label>
        {err && <p className="text-sm text-red-600 mt-3">{err}</p>}
        <button disabled={loading} className="mt-5 w-full rounded-lg bg-drive-accent text-white py-2 hover:bg-drive-accentHover disabled:opacity-60">
          {loading ? "Creating…" : "Create account"}
        </button>
        <p className="mt-4 text-sm text-drive-muted text-center">
          Already have an account?{" "}
          <Link
            className="text-drive-accent hover:underline"
            href={next ? `/login?next=${encodeURIComponent(next)}` : "/login"}
          >
            Sign in
          </Link>
        </p>
      </form>
  );
}

export default function SignupPage() {
  return (
    <main className="min-h-screen min-h-[100dvh] flex items-center justify-center px-6">
      <Suspense fallback={null}>
        <SignupForm />
      </Suspense>
    </main>
  );
}
