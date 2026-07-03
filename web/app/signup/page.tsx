"use client";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// Verify-before-create: (1) enter email → a 6-digit code is emailed; (2) enter
// the code + name + password to create the account. Every account therefore has
// a verified email. An already-registered email short-circuits step 1 to a
// "sign in instead" hint.
function SignupForm() {
  const router = useRouter();
  const search = useSearchParams();
  const next = search.get("next");
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const loginHref = next ? `/login?next=${encodeURIComponent(next)}` : "/login";

  const [step, setStep] = useState<"email" | "details">("email");
  const [email, setEmail] = useState("");
  const [alreadyRegistered, setAlreadyRegistered] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function requestCode(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true); setErr(null); setAlreadyRegistered(false);
    const addr = String(new FormData(e.currentTarget).get("email") || "");
    const res = await fetch("/api/auth/signup/request-code", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: addr }),
    });
    setLoading(false);
    if (!res.ok) { setErr((await res.json().catch(() => ({}))).error || "Could not send code"); return; }
    const body = await res.json();
    if (body.alreadyRegistered) { setAlreadyRegistered(true); return; }
    setEmail(addr);
    setStep("details");
  }

  async function createAccount(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true); setErr(null);
    const fd = new FormData(e.currentTarget);
    const res = await fetch("/api/auth/signup", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, code: fd.get("code"), name: fd.get("name"), password: fd.get("password") }),
    });
    setLoading(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const map: Record<string, string> = {
        invalid_code: "That code is not correct. Check it and try again.",
        no_active_code: "This code has expired or was already used. Request a new one.",
        too_many_attempts: "Too many tries. Go back and request a new code.",
        "email already registered": "This email was just registered. Sign in instead.",
      };
      setErr(map[body.error] || body.error || "Could not create account.");
      return;
    }
    router.push(safeNext);
  }

  return (
    <div className="w-full max-w-sm bg-white border border-drive-border rounded-2xl p-6 shadow-drive">
      <h1 className="text-xl font-semibold">Create your aindrive</h1>

      {step === "email" ? (
        <form onSubmit={requestCode}>
          <p className="mt-2 text-sm text-drive-muted">Enter your email — we’ll send a verification code.</p>
          <label className="block mt-5 text-sm">Email
            <input name="email" type="email" required autoFocus className="mt-1 w-full rounded-lg border border-drive-border px-3 py-2" />
          </label>
          {alreadyRegistered && (
            <p className="text-sm text-drive-muted mt-3">
              This email already has an account.{" "}
              <Link className="text-drive-accent hover:underline" href={loginHref}>Sign in</Link>.
            </p>
          )}
          {err && <p className="text-sm text-red-600 mt-3">{err}</p>}
          <button disabled={loading} className="mt-5 w-full rounded-lg bg-drive-accent text-white py-2 hover:bg-drive-accentHover disabled:opacity-60">
            {loading ? "Sending…" : "Send code"}
          </button>
        </form>
      ) : (
        <form onSubmit={createAccount}>
          <p className="mt-2 text-sm text-drive-muted">Enter the code sent to <span className="text-drive-text">{email}</span>, then finish your account.</p>
          <label className="block mt-5 text-sm">Verification code
            <input name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} required autoFocus
              className="mt-1 w-full rounded-lg border border-drive-border px-3 py-2 tracking-[0.4em] text-center font-mono" />
          </label>
          <label className="block mt-3 text-sm">Name
            <input name="name" required className="mt-1 w-full rounded-lg border border-drive-border px-3 py-2" />
          </label>
          <label className="block mt-3 text-sm">Password
            <input name="password" type="password" minLength={8} required className="mt-1 w-full rounded-lg border border-drive-border px-3 py-2" />
          </label>
          {err && <p className="text-sm text-red-600 mt-3">{err}</p>}
          <button disabled={loading} className="mt-5 w-full rounded-lg bg-drive-accent text-white py-2 hover:bg-drive-accentHover disabled:opacity-60">
            {loading ? "Creating…" : "Create account"}
          </button>
          <button type="button" onClick={() => { setStep("email"); setErr(null); }}
            className="mt-3 w-full text-xs text-drive-muted hover:text-drive-accent hover:underline">
            Use a different email
          </button>
        </form>
      )}

      <p className="mt-4 text-sm text-drive-muted text-center">
        Already have an account?{" "}
        <Link className="text-drive-accent hover:underline" href={loginHref}>Sign in</Link>
      </p>
    </div>
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
