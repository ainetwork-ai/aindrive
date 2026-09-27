/**
 * AIN SSO configuration (lib/sso/README.md). Everything is OFF unless the
 * operator sets it, and with nothing set aindrive behaves exactly as before:
 *
 *   AINDRIVE_SSO_ISSUER         AIN SSO issuer, e.g. https://auth.comcom.ai
 *   AINDRIVE_SSO_CLIENT_ID      aindrive's OIDC client_id at AIN SSO (also the
 *                               `aud` of adapter and logout tokens)
 *   AINDRIVE_SSO_CLIENT_SECRET  confidential-client secret (client_secret_basic)
 *   AINDRIVE_SSO_ENABLED        true → show "Continue with AIN" (needs all three above)
 *   AINDRIVE_LEGACY_LOGIN       true (default) | unlinked_only | false
 *
 * Issuer + client id alone make the provisioning adapter and back-channel
 * logout live (runbook step 1: adapter deployed, SSO login hidden). The legacy
 * switch only applies while SSO login is enabled — turning SSO login off is the
 * rollback, so every legacy method works again (suspension still holds: it is
 * stored per account, lib/sso/store.js).
 */
import { env } from "../env";

export type LegacyLoginMode = "true" | "unlinked_only" | "false";
export const LEGACY_LOGIN_MODES: readonly LegacyLoginMode[] = ["true", "unlinked_only", "false"];

export type AdapterConfig = { issuer: string; clientId: string };
export type SsoLoginConfig = AdapterConfig & { clientSecret: string };

const val = (name: string) => (process.env[name] ?? "").trim();

/** https, or http only for a loopback issuer / outside production (local AIN SSO). */
export function isAcceptableIssuer(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.search || u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol !== "http:") return false;
  return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || process.env.NODE_ENV !== "production";
}

/** Issuer + client id: enough to verify AIN-signed adapter and logout tokens. */
export function adapterConfig(): AdapterConfig | null {
  const issuer = val("AINDRIVE_SSO_ISSUER");
  const clientId = val("AINDRIVE_SSO_CLIENT_ID");
  if (!issuer || !clientId || !isAcceptableIssuer(issuer)) return null;
  return { issuer, clientId };
}

/** Everything the sign-in flow needs, or null when SSO login is off. */
export function ssoLoginConfig(): SsoLoginConfig | null {
  const base = adapterConfig();
  const clientSecret = val("AINDRIVE_SSO_CLIENT_SECRET");
  if (!base || !clientSecret) return null;
  if (!/^(true|1)$/i.test(val("AINDRIVE_SSO_ENABLED"))) return null;
  return { ...base, clientSecret };
}

export function ssoLoginEnabled(): boolean {
  return ssoLoginConfig() !== null;
}

/** The configured legacy switch (unknown values fall back to the default; boot-checks refuse them in production). */
export function configuredLegacyLoginMode(): LegacyLoginMode {
  const raw = val("AINDRIVE_LEGACY_LOGIN").toLowerCase();
  return (LEGACY_LOGIN_MODES as readonly string[]).includes(raw) ? (raw as LegacyLoginMode) : "true";
}

/** The switch in effect: the configured one while SSO login is on, otherwise "true". */
export function legacyLoginMode(): LegacyLoginMode {
  return ssoLoginEnabled() ? configuredLegacyLoginMode() : "true";
}

/** This server's public origin (no trailing slash). */
export function publicBase(): string {
  return env.publicUrl.replace(/\/+$/, "");
}

/** Registered at AIN SSO as aindrive's redirect_uri. */
export function ssoRedirectUri(): string {
  return `${publicBase()}/api/auth/sso/callback`;
}

/** Registered at AIN SSO as aindrive's post_logout_redirect_uri. */
export function ssoPostLogoutRedirectUri(): string {
  return `${publicBase()}/`;
}
