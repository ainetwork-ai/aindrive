"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";

// Two-step reset: (1) enter email → a 6-digit code is emailed; (2) enter the
// code + a new password. Step 1's response is deliberately identical whether or
// not the email is registered (anti-enumeration), so the UI always advances to
// step 2 and simply says "if that email has an account, a code was sent".
export default function ForgotPasswordPage() {
  const router = useRouter();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function requestCode(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true); setErr(null);
    const fd = new FormData(e.currentTarget);
    const addr = String(fd.get("email") || "");
    await fetch("/api/auth/forgot-password", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: addr }),
    });
    setLoading(false);
    setEmail(addr);
    setStep("code");
    setNotice(`If an account exists for ${addr}, a 6-digit code is on its way. It expires in 10 minutes.`);
  }

  async function submitReset(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true); setErr(null);
    const fd = new FormData(e.currentTarget);
    const res = await fetch("/api/auth/reset-password", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, code: fd.get("code"), newPassword: fd.get("newPassword") }),
    });
    setLoading(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const map: Record<string, string> = {
        invalid_code: "That code is not correct. Check it and try again.",
        no_active_code: "This code has expired or was already used. Request a new one.",
        too_many_attempts: "Too many tries. Request a new code.",
        rate_limited: "Too many attempts — wait a minute and try again.",
        "invalid input": "Password must be at least 8 characters.",
      };
      setErr(map[body.error] || body.error || "Could not reset password.");
      return;
    }
    router.push("/login");
  }

  return (
    <main className="min-h-screen min-h-[100dvh] flex items-center justify-center px-6">
      <div className="w-full max-w-sm bg-white border border-drive-border rounded-2xl p-6 shadow-drive">
        <h1 className="text-xl font-semibold">Reset password</h1>

        {step === "email" ? (
          <form onSubmit={requestCode}>
            <p className="mt-2 text-sm text-drive-muted">Enter your account email and we’ll send a code.</p>
            <label className="block mt-5 text-sm">Email
              <input name="email" type="email" autoComplete="email" required autoFocus className="mt-1 w-full rounded-lg border border-drive-border px-3 py-2" />
            </label>
            <button disabled={loading} className="mt-5 w-full rounded-lg bg-drive-accent text-white py-2 hover:bg-drive-accentHover disabled:opacity-60">
              {loading ? "Sending…" : "Send code"}
            </button>
          </form>
        ) : (
          <form onSubmit={submitReset}>
            {notice && <p className="mt-2 text-sm text-drive-muted">{notice}</p>}
            <label className="block mt-5 text-sm">6-digit code
              {/* one-time-code: without it the browser autofills a saved email/username here */}
              <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus
                className="mt-1 w-full rounded-lg border border-drive-border px-3 py-2 tracking-[0.4em] text-center font-mono" />
            </label>
            <label className="block mt-3 text-sm">New password
              <input name="newPassword" type="password" autoComplete="new-password" minLength={8} required className="mt-1 w-full rounded-lg border border-drive-border px-3 py-2" />
            </label>
            {err && <p className="text-sm text-red-600 mt-3">{err}</p>}
            <button disabled={loading} className="mt-5 w-full rounded-lg bg-drive-accent text-white py-2 hover:bg-drive-accentHover disabled:opacity-60">
              {loading ? "Resetting…" : "Reset password"}
            </button>
            <button type="button" onClick={() => { setStep("email"); setErr(null); setNotice(null); }}
              className="mt-3 w-full text-xs text-drive-muted hover:text-drive-accent hover:underline">
              Use a different email
            </button>
          </form>
        )}

        <p className="mt-4 text-sm text-drive-muted text-center">
          <Link className="text-drive-accent hover:underline" href="/login">Back to sign in</Link>
        </p>
      </div>
    </main>
  );
}
