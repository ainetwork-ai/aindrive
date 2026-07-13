"use client";
import { useState } from "react";
import { Button } from "@/components/ui";

type Stage = "email" | "code" | "done";

// Opt-in second login for wallet-only accounts: email -> OTP+password ->
// done. Hits POST /api/account/email/start then /verify (see those routes
// for the server-side contract this form assumes).
export function AddEmailForm() {
  const [stage, setStage] = useState<Stage>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    const res = await fetch("/api/account/email/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    setBusy(false);
    if (!res.ok) { setErr((await res.json().catch(() => ({}))).error || "could not send code"); return; }
    setStage("code");
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    const res = await fetch("/api/account/email/verify", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, code, password }),
    });
    setBusy(false);
    if (!res.ok) { setErr((await res.json().catch(() => ({}))).error || "could not verify"); return; }
    setStage("done");
  }

  if (stage === "done") {
    return <p className="mt-3 text-sm text-drive-accent">Email added — you can now also sign in with {email}.</p>;
  }
  return (
    <form onSubmit={stage === "email" ? start : verify} className="mt-3 flex flex-col gap-2 max-w-sm">
      <input
        type="email" required placeholder="you@example.com" value={email}
        onChange={(e) => setEmail(e.target.value)} disabled={stage === "code"}
        className="rounded-lg border border-drive-border px-3 py-2 text-sm"
      />
      {stage === "code" && (
        <>
          <input
            required placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)}
            className="rounded-lg border border-drive-border px-3 py-2 text-sm"
          />
          <input
            type="password" required minLength={8} placeholder="Set a password" value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-lg border border-drive-border px-3 py-2 text-sm"
          />
        </>
      )}
      {err && <p className="text-sm text-red-600">{err}</p>}
      <Button type="submit" size="sm" loading={busy} disabled={busy} className="self-start">
        {stage === "email" ? "Send code" : "Verify & add email"}
      </Button>
    </form>
  );
}
