/**
 * runBootChecks — called once at server startup.
 * In development (NODE_ENV !== "production") every check is a no-op so local
 * hacking is unaffected. In production any violation prints a clear message
 * and calls process.exit(1).
 */
export function runBootChecks() {
  if (process.env.NODE_ENV !== "production") return;

  const errors = [];

  // 1. DEV bypass must never be on in production.
  if (process.env.AINDRIVE_DEV_BYPASS_X402 === "1") {
    errors.push(
      "AINDRIVE_DEV_BYPASS_X402=1 is set in production — every paid share would be free. Unset it."
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

  if (errors.length > 0) {
    console.error("\n[aindrive] BOOT FAILED — production environment is misconfigured:\n");
    for (const msg of errors) {
      console.error(`  ✗ ${msg}`);
    }
    console.error("");
    process.exit(1);
  }
}
