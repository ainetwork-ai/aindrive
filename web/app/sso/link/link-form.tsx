"use client";
import { useState } from "react";

const ERRORS: Record<string, string> = {
  expired: "This sign-in expired. Start again from the sign-in page.",
  "invalid credentials": "Wrong email or password.",
  "not signed in": "You're no longer signed in to that account.",
  account_already_linked: "That aindrive account is already connected to another AIN account.",
  sub_already_linked: "Your AIN account was just connected to another aindrive account. Sign in again.",
  account_suspended: "That account is suspended by your organization.",
  legacy_login_disabled: "Connecting an existing account is turned off on this server.",
  rate_limited: "Too many attempts — try again in a minute.",
};

type Props = {
  ain: { name: string | null; email: string | null };
  current: { label: string; email: string } | null;
  allowLegacy: boolean;
  /** Where "Not now" goes: the page the sign-in started from (same-origin, validated). */
  skipHref: string;
};

export default function SsoLinkForm({ ain, current, allowLegacy, skipHref }: Props) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(body: Record<string, unknown>) {
    setBusy(true); setErr(null);
    const res = await fetch("/api/auth/sso/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    const out = (await res?.json().catch(() => null)) as { redirect?: string; error?: string } | null;
    if (!res?.ok || !out?.redirect) {
      setBusy(false);
      setErr(ERRORS[out?.error ?? ""] ?? "Something went wrong. Try again.");
      return;
    }
    window.location.assign(out.redirect);
  }

  function onPassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    void submit({ method: "legacy_password", email: fd.get("email"), password: fd.get("password") });
  }

  const who = [ain.name, ain.email].filter(Boolean).join(" · ") || "your AIN account";
  return (
    <div className="w-full max-w-sm bg-white border border-drive-border rounded-2xl p-6 shadow-drive">
      <h1 className="text-xl font-semibold">Connect your aindrive account</h1>
      <p className="mt-2 text-sm text-drive-muted">Signed in to AIN as <span className="text-drive-text">{who}</span>.</p>
      {allowLegacy && (
        <>
          <p className="mt-4 text-sm">If you already use aindrive, connect that account once. Its drives, shares and purchases stay as they are.</p>
          {current && (
            <button type="button" disabled={busy} onClick={() => void submit({ method: "legacy_session" })}
              className="mt-4 w-full rounded-lg bg-drive-accent text-white py-2 hover:bg-drive-accentHover disabled:opacity-60">
              Connect {current.label}
            </button>
          )}
          <form onSubmit={onPassword} className="mt-4">
            <label className="block text-sm">aindrive email
              <input name="email" type="email" autoComplete="email" required className="mt-1 w-full rounded-lg border border-drive-border px-3 py-2" />
            </label>
            <label className="block mt-3 text-sm">Password
              <input name="password" type="password" autoComplete="current-password" required className="mt-1 w-full rounded-lg border border-drive-border px-3 py-2" />
            </label>
            <button disabled={busy} className="mt-4 w-full rounded-lg border border-drive-border py-2 font-medium hover:bg-drive-hover disabled:opacity-60">
              Connect with password
            </button>
          </form>
          <p className="mt-3 text-xs text-drive-muted">
            Use a wallet or Google? <a className="text-drive-accent hover:underline" href="/login?next=%2Fsso%2Flink">Sign in with it first</a>, then come back here.
          </p>
          <div className="mt-6 flex items-center gap-3 text-xs text-drive-muted">
            <span className="h-px flex-1 bg-drive-border" />
            or
            <span className="h-px flex-1 bg-drive-border" />
          </div>
        </>
      )}
      <button type="button" disabled={busy} onClick={() => void submit({ method: "new" })}
        className="mt-4 w-full rounded-lg border border-drive-border py-2 font-medium hover:bg-drive-hover disabled:opacity-60">
        Create a new aindrive account
      </button>
      {err && <p className="text-sm text-red-600 mt-3">{err}</p>}
      <p className="mt-4 text-center text-xs text-drive-muted">
        <a className="hover:text-drive-accent hover:underline" href={skipHref} data-testid="sso-link-skip">Not now</a>
      </p>
    </div>
  );
}
