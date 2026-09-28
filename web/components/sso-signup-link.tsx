"use client";
/**
 * "Sign up with AIN" — creating the account at AIN SSO (OIDC Prompt Create:
 * /api/auth/sso/start?prompt=create → AIN SSO's sign-up page, Google or
 * passkey), then back here signed in. Renders nothing unless AIN SSO sign-in
 * is on (useSsoStatus). While AINDRIVE_LEGACY_LOGIN=true it sits next to the
 * legacy sign-up; otherwise it is the sign-up (app/signup, app/login).
 */
import { ssoStartHref, useSsoStatus } from "./use-sso-status";

export default function SsoSignUpLink({ next, variant = "button" }: { next: string; variant?: "button" | "link" }) {
  const status = useSsoStatus();
  if (!status) return null;
  const href = ssoStartHref(next, { prompt: "create" });
  if (variant === "link") {
    return <a className="text-drive-accent hover:underline" href={href} data-testid="sso-signup">sign up with AIN</a>;
  }
  return (
    <div className="mt-4" data-testid="sso-signup">
      <a
        href={href}
        className="w-full flex items-center justify-center gap-2 rounded-lg border border-drive-border py-2 font-medium hover:bg-drive-hover"
      >
        Sign up with AIN
      </a>
    </div>
  );
}
