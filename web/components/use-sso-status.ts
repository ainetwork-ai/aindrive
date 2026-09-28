"use client";
/**
 * Whether AIN SSO sign-in is on here (GET /api/auth/sso → {enabled,
 * legacyLogin}; 404 → null). Fetched once per page load and shared by the
 * sign-in/sign-up controls, so a server without AIN SSO renders them exactly
 * as before.
 */
import { useEffect, useState } from "react";

export type SsoStatus = { enabled: true; legacyLogin: "true" | "unlinked_only" | "false" };

let pending: Promise<SsoStatus | null> | null = null;

export function loadSsoStatus(): Promise<SsoStatus | null> {
  pending ??= fetch("/api/auth/sso")
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg: Partial<SsoStatus> | null) =>
      cfg?.enabled ? { enabled: true as const, legacyLogin: cfg.legacyLogin ?? "true" } : null)
    .catch(() => null);
  return pending;
}

export function useSsoStatus(): SsoStatus | null {
  const [status, setStatus] = useState<SsoStatus | null>(null);
  useEffect(() => {
    let alive = true;
    void loadSsoStatus().then((s) => { if (alive) setStatus(s); });
    return () => { alive = false; };
  }, []);
  return status;
}

/** /api/auth/sso/start with the given parameters (next is URL-encoded). */
export function ssoStartHref(next: string, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({ ...extra, next });
  return `/api/auth/sso/start?${q.toString()}`;
}
