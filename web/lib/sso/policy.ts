/**
 * Which non-SSO ("legacy") sign-in and recovery paths an account may use.
 * Called by /api/auth/{login,google,signup,forgot-password,reset-password},
 * /api/wallet/login and /api/auth/cli/poll. Order of the rules:
 *
 *  1. Suspended through AIN SSO (lib/sso/store.js isAccountBlocked) → refused
 *     on EVERY path, whatever the switches say (runbook: rollback must never
 *     re-activate a suspended employee).
 *  2. AINDRIVE_LEGACY_LOGIN=false (only while SSO login is on) → refused.
 *  3. AINDRIVE_LEGACY_LOGIN=unlinked_only → refused for accounts linked to AIN.
 *
 * Email-OTP password reset is never available to an AIN-linked account, under
 * any switch (ADR-0004 amendment: a reassigned mailbox must not take over the
 * account or its AIN link).
 */
import { legacyLoginMode } from "./config";
import { isAccountBlocked, isSsoLinked } from "./store.js";

export type Refusal = { status: 403; error: "account_suspended" | "sso_required" | "legacy_login_disabled" | "reset_unavailable" };

/** null = allowed. `userId` null = no account resolved yet (e.g. before creating one). */
export function legacyLoginRefusal(userId: string | null): Refusal | null {
  if (userId && isAccountBlocked(userId)) return { status: 403, error: "account_suspended" };
  const mode = legacyLoginMode();
  if (mode === "false") return { status: 403, error: "legacy_login_disabled" };
  if (mode === "unlinked_only" && userId && isSsoLinked(userId)) return { status: 403, error: "sso_required" };
  return null;
}

/** Email-OTP password reset for this account (null = allowed). */
export function passwordResetRefusal(userId: string | null): Refusal | null {
  if (legacyLoginMode() === "false") return { status: 403, error: "legacy_login_disabled" };
  if (userId && (isAccountBlocked(userId) || isSsoLinked(userId))) return { status: 403, error: "reset_unavailable" };
  return null;
}

/** Messages the web UI shows for the refusals above. */
export const REFUSAL_MESSAGES: Record<Refusal["error"], string> = {
  account_suspended: "This account is suspended by your organization.",
  sso_required: "This account signs in with AIN. Use “Continue with AIN”.",
  legacy_login_disabled: "Sign in with AIN. Other sign-in methods are turned off on this server.",
  reset_unavailable: "This account can't reset its password by email. Sign in with AIN.",
};
