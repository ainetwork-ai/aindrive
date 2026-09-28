/**
 * runBootChecks — called once at server startup.
 * In development (NODE_ENV !== "production") every check is a no-op so local
 * hacking is unaffected. In production any violation prints a clear message
 * and calls process.exit(1).
 */
export function runBootChecks() {
  if (process.env.NODE_ENV !== "production") return;

  const errors = [];

  // 1. DEV bypasses must never be on in production.
  if (process.env.AINDRIVE_DEV_BYPASS_X402 === "1") {
    errors.push(
      "AINDRIVE_DEV_BYPASS_X402=1 is set in production — every paid share would be free. Unset it."
    );
  }
  if (process.env.AINDRIVE_DEV_BYPASS_OTP === "1") {
    errors.push(
      "AINDRIVE_DEV_BYPASS_OTP=1 is set in production — signup would skip email verification. Unset it."
    );
  }

  // 2. Session secret must be present and at least 32 bytes.
  const secret = process.env.AINDRIVE_SESSION_SECRET ?? "";
  if (!secret) {
    errors.push(
      "AINDRIVE_SESSION_SECRET is not set. Generate one with: node -e \"process.stdout.write(require('crypto').randomBytes(32).toString('hex'))\""
    );
  } else if (secret.length < 32) {
    errors.push(
      `AINDRIVE_SESSION_SECRET is too short (${secret.length} chars). Minimum 32 characters (ideally 64-char hex from 32 random bytes).`
    );
  }

  // 3. Public URL must use HTTPS.
  const publicUrl = process.env.AINDRIVE_PUBLIC_URL ?? "";
  if (!publicUrl) {
    errors.push(
      "AINDRIVE_PUBLIC_URL is not set. Set it to your public https:// URL so cookies can be marked Secure."
    );
  } else if (!publicUrl.startsWith("https://")) {
    errors.push(
      `AINDRIVE_PUBLIC_URL must start with https:// (got: ${publicUrl}). Secure cookies cannot be set over plain HTTP.`
    );
  }

  // Payout wallet is per-drive (Settings → Payments), enforced when a paid
  // share is created — not a deployment-wide env var. No boot check here.

  // 4. AIN SSO (lib/sso/config.ts). Unset = off, nothing to check. Only a
  //    value the operator set but got wrong fails the boot, so a typo never
  //    silently leaves legacy login on or SSO half-configured.
  errors.push(...ssoConfigErrors(process.env));

  if (errors.length > 0) {
    console.error("\n[aindrive] BOOT FAILED — production environment is misconfigured:\n");
    for (const msg of errors) {
      console.error(`  ✗ ${msg}`);
    }
    console.error("");
    process.exit(1);
  }
}

/**
 * Misconfiguration of the AIN SSO variables (production rules; see
 * lib/sso/config.ts). Returns [] when none of them is set.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function ssoConfigErrors(env) {
  const v = (k) => (env[k] ?? "").trim();
  const errors = [];
  const legacy = v("AINDRIVE_LEGACY_LOGIN");
  if (legacy && !["true", "unlinked_only", "false"].includes(legacy.toLowerCase())) {
    errors.push(`AINDRIVE_LEGACY_LOGIN must be true, unlinked_only or false (got: ${legacy}).`);
  }
  const enabled = v("AINDRIVE_SSO_ENABLED");
  if (enabled && !/^(true|false|1|0)$/i.test(enabled)) {
    errors.push(`AINDRIVE_SSO_ENABLED must be true or false (got: ${enabled}).`);
  }
  for (const k of ["AINDRIVE_SSO_SILENT", "AINDRIVE_SSO_ATTEST"]) {
    const x = v(k);
    if (x && !/^(true|false|1|0|on|off)$/i.test(x)) errors.push(`${k} must be true or false (got: ${x}).`);
  }
  const domains = v("AINDRIVE_SSO_ATTEST_EMAIL_DOMAINS");
  if (domains && domains.toLowerCase() !== "none") {
    const bad = domains.split(",").map((d) => d.trim().replace(/^@/, "")).filter(Boolean).filter((d) => !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(d));
    if (bad.length) errors.push(`AINDRIVE_SSO_ATTEST_EMAIL_DOMAINS must be comma-separated domains or none (bad: ${bad.join(", ")}).`);
  }
  const issuer = v("AINDRIVE_SSO_ISSUER");
  const clientId = v("AINDRIVE_SSO_CLIENT_ID");
  const secret = v("AINDRIVE_SSO_CLIENT_SECRET");
  if (issuer || clientId || secret) {
    if (!issuer || !clientId) errors.push("AINDRIVE_SSO_ISSUER and AINDRIVE_SSO_CLIENT_ID must be set together.");
    if (issuer) {
      let ok = false;
      try { const u = new URL(issuer); ok = u.protocol === "https:" && !u.search && !u.hash; } catch {}
      if (!ok) errors.push(`AINDRIVE_SSO_ISSUER must be an https:// URL without query or fragment (got: ${issuer}).`);
    }
  }
  if (/^(true|1)$/i.test(enabled) && (!issuer || !clientId || !secret)) {
    errors.push("AINDRIVE_SSO_ENABLED=true needs AINDRIVE_SSO_ISSUER, AINDRIVE_SSO_CLIENT_ID and AINDRIVE_SSO_CLIENT_SECRET.");
  }
  return errors;
}
