"use client";
/**
 * "Continue with AIN" — sign-in through AIN SSO (lib/sso). Renders nothing
 * unless the server has it on (GET /api/auth/sso → 404 otherwise), so the
 * login page is unchanged on servers without AIN SSO. The button is a plain
 * link: /api/auth/sso/start redirects to AIN SSO and back.
 *
 * Also shows why a previous AIN sign-in came back to /login (`?sso_error=`).
 */
import { useSearchParams } from "next/navigation";
import { ssoStartHref, useSsoStatus } from "./use-sso-status";

const ERRORS: Record<string, string> = {
  access_denied: "Your organization hasn't given you access to aindrive.",
  account_suspended: "This account is suspended by your organization.",
  expired: "The sign-in took too long. Try again.",
  sso_unavailable: "AIN sign-in is unavailable right now. Try again in a moment.",
};

export default function SsoSignInButton({ next }: { next: string }) {
  const search = useSearchParams();
  const status = useSsoStatus();
  const code = search.get("sso_error");

  if (!status) return null;
  return (
    <div className="mt-4" data-testid="sso-signin">
      <a
        href={ssoStartHref(next)}
        className="w-full flex items-center justify-center gap-2 rounded-lg border border-drive-border py-2 font-medium hover:bg-drive-hover"
      >
        Continue with AIN
      </a>
      {code && <p className="mt-2 text-center text-sm text-red-600">{ERRORS[code] ?? "AIN sign-in failed. Try again."}</p>}
    </div>
  );
}
