/**
 * AIN SSO's SSH public-key directory, as aindrive's git-over-SSH server
 * (lib/git-ssh/*) consults it to turn an offered key into an AIN account.
 *
 * Contract (AIN SSO, app-authenticated with aindrive's client credentials,
 * client_secret_basic — the same credentials app-attest and app-proof use):
 *
 *   GET {ISSUER}/api/apps/ssh-keys/lookup?fingerprint=SHA256:<base64>
 *     200 { subject, email, name, key_type, public_key, fingerprint, title, created_at }
 *     404 {"error":"not_found"}
 *   GET {ISSUER}/api/apps/ssh-keys/by-subject?subject=acc_…
 *     200 { subject, keys: [{ key_type, public_key, fingerprint, title, created_at }] }
 *
 * Behind an interface so the SSH server is tested with a fake directory; the
 * HTTP client here is covered by injecting `fetch`. Answers are cached for at
 * most CACHE_TTL_MS (positive and negative), so a `git push` that offers the
 * same key several times in a minute asks AIN SSO once.
 */
import { createHash } from "node:crypto";
import type { SsoLoginConfig } from "./sso/config";

export type SshKeyRecord = {
  subject: string;
  email?: string | null;
  name?: string | null;
  key_type: string;
  public_key: string;
  fingerprint: string;
  title?: string | null;
  created_at?: string | null;
};

export interface SshKeyDirectory {
  /** The account that registered the key with this fingerprint, or null when none did. */
  byFingerprint(fingerprint: string): Promise<SshKeyRecord | null>;
  /** Every key `subject` registered (the empty list for an unknown subject). */
  bySubject(subject: string): Promise<SshKeyRecord[]>;
}

export const CACHE_TTL_MS = 60_000;

/** OpenSSH-style fingerprint of a raw public-key blob: `SHA256:` + unpadded base64. */
export function sshFingerprint(keyBlob: Uint8Array): string {
  return "SHA256:" + createHash("sha256").update(keyBlob).digest("base64").replace(/=+$/, "");
}

export function isSshFingerprint(s: string): boolean {
  return /^SHA256:[A-Za-z0-9+/]{43}$/.test(s);
}

export class SsoSshKeyLookupError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

/** The HTTP client for the contract above. */
export function createSsoSshKeyDirectory(config: SsoLoginConfig, fetchImpl: typeof fetch = fetch, timeoutMs = 5_000): SshKeyDirectory {
  const base = config.issuer.replace(/\/+$/, "");
  const basic = Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString("base64");
  const get = async (path: string): Promise<{ status: number; body: unknown }> => {
    const res = await fetchImpl(`${base}${path}`, {
      method: "GET",
      headers: { authorization: `Basic ${basic}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  };
  return {
    async byFingerprint(fingerprint) {
      if (!isSshFingerprint(fingerprint)) return null;
      const { status, body } = await get(`/api/apps/ssh-keys/lookup?fingerprint=${encodeURIComponent(fingerprint)}`);
      if (status === 404) return null;
      if (status !== 200) throw new SsoSshKeyLookupError(`ssh key lookup answered ${status}`, status);
      const rec = body as Partial<SshKeyRecord> | null;
      if (!rec || typeof rec.subject !== "string" || typeof rec.public_key !== "string" || typeof rec.fingerprint !== "string") {
        throw new SsoSshKeyLookupError("ssh key lookup answered an unexpected body", 502);
      }
      // Never trust a record for a different key than the one asked about.
      if (rec.fingerprint !== fingerprint) return null;
      return rec as SshKeyRecord;
    },
    async bySubject(subject) {
      const { status, body } = await get(`/api/apps/ssh-keys/by-subject?subject=${encodeURIComponent(subject)}`);
      if (status === 404) return [];
      if (status !== 200) throw new SsoSshKeyLookupError(`ssh key listing answered ${status}`, status);
      const b = body as { subject?: string; keys?: Partial<SshKeyRecord>[] } | null;
      if (!b || !Array.isArray(b.keys)) throw new SsoSshKeyLookupError("ssh key listing answered an unexpected body", 502);
      return b.keys
        .filter((k): k is SshKeyRecord => typeof k?.public_key === "string" && typeof k?.fingerprint === "string")
        .map((k) => ({ ...k, subject: b.subject ?? subject }));
    },
  };
}

/**
 * Memoize a directory for `ttlMs` (≤ CACHE_TTL_MS; the cap holds even when a
 * larger value is passed). A lookup that throws is not cached, so a transient
 * AIN SSO error is retried on the next key offer.
 */
export function cachedSshKeyDirectory(inner: SshKeyDirectory, ttlMs = CACHE_TTL_MS, now: () => number = Date.now): SshKeyDirectory {
  const ttl = Math.min(Math.max(0, ttlMs), CACHE_TTL_MS);
  const fp = new Map<string, { at: number; value: SshKeyRecord | null }>();
  const subj = new Map<string, { at: number; value: SshKeyRecord[] }>();
  const fresh = (at: number) => now() - at < ttl;
  return {
    async byFingerprint(fingerprint) {
      const hit = fp.get(fingerprint);
      if (hit && fresh(hit.at)) return hit.value;
      const value = await inner.byFingerprint(fingerprint);
      fp.set(fingerprint, { at: now(), value });
      if (fp.size > 10_000) fp.clear();
      return value;
    },
    async bySubject(subject) {
      const hit = subj.get(subject);
      if (hit && fresh(hit.at)) return hit.value;
      const value = await inner.bySubject(subject);
      subj.set(subject, { at: now(), value });
      if (subj.size > 10_000) subj.clear();
      return value;
    },
  };
}
