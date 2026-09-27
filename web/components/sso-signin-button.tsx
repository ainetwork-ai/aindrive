"use client";
/**
 * "Continue with AIN" — sign-in through AIN SSO (lib/sso). Renders nothing
 * unless the server has it on (GET /api/auth/sso → 404 otherwise), so the
 * login page is unchanged on servers without AIN SSO. The button is a plain
 * link: /api/auth/sso/start redirects to AIN SSO and back.
 *
 * Also shows why a previous AIN sign-in came back to /login (`?sso_error=`).
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

const ERRORS: Record<string, string> = {
  access_denied: "Your organization hasn't given you access to aindrive.",
  account_suspended: "This account is suspended by your organization.",
  expired: "The sign-in took too long. Try again.",
  sso_unavailable: "AIN sign-in is unavailable right now. Try again in a moment.",
};

export default function SsoSignInButton({ next }: { next: string }) {
  const search = useSearchParams();
  const [enabled, setEnabled] = useState(false);
  const code = search.get("sso_error");

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/sso")
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg: { enabled?: boolean } | null) => { if (alive) setEnabled(!!cfg?.enabled); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!enabled) return null;
  return (
    <div className="mt-4" data-testid="sso-signin">
      <a
        href={`/api/auth/sso/start?next=${encodeURIComponent(next)}`}
        className="w-full flex items-center justify-center gap-2 rounded-lg border border-drive-border py-2 font-medium hover:bg-drive-hover"
      >
        Continue with AIN
      </a>
      {code && <p className="mt-2 text-center text-sm text-red-600">{ERRORS[code] ?? "AIN sign-in failed. Try again."}</p>}
    </div>
  );
}
