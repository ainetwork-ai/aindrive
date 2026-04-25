/**
 * runBootChecks — called once at server startup.
 * In development (NODE_ENV !== "production") every check is a no-op so local
 * hacking is unaffected. In production any violation prints a clear message
 * and calls process.exit(1).
 */
export function runBootChecks(): void {
  if (process.env.NODE_ENV !== "production") return;

  const errors: string[] = [];

  // 1. DEV bypass must never be on in production.
  if (process.env.AINDRIVE_DEV_BYPASS_X402 === "1") {
    errors.push(
      "AINDRIVE_DEV_BYPASS_X402=1 is set in production — every paid share would be free. Unset it."
    );
  }

  // 2. Session secret must be present and at least 32 bytes (64 hex chars or 44 base64 chars).
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

  // 4. Payout wallet must be set when x402 is active.
  const bypassX402 = process.env.AINDRIVE_DEV_BYPASS_X402 === "1";
  if (!bypassX402) {
    const wallet = process.env.AINDRIVE_PAYOUT_WALLET ?? "";
    if (!wallet) {
      errors.push(
        "AINDRIVE_PAYOUT_WALLET is not set. Set it to your payout wallet address so x402 payments can be received."
      );
    } else if (/^0x0+$/i.test(wallet)) {
      errors.push(
        `AINDRIVE_PAYOUT_WALLET is all-zeros (${wallet}). Replace with a real wallet address before accepting payments.`
      );
    }
  }

  if (errors.length > 0) {
    console.error("\n[aindrive] BOOT FAILED — production environment is misconfigured:\n");
    for (const msg of errors) {
      console.error(`  ✗ ${msg}`);
    }
    console.error("");
    process.exit(1);
  }
}
