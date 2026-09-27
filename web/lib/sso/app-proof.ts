/**
 * Reports an in-app legacy link to AIN SSO (ADR-0004 `app_proof`):
 * `POST {issuer}/api/upstream/app-proof` with client_secret_basic and
 * `{sub, legacyUserId, method}`. Best effort: the local link is authoritative
 * for aindrive, so a failure is logged and audited, never shown to the user.
 */
import { audit } from "./store.js";
import type { SsoLoginConfig } from "./config";

export type AppProofMethod = "legacy_session" | "wallet_signature" | "legacy_password";

export async function reportAppProof(
  config: SsoLoginConfig,
  input: { sub: string; legacyUserId: string; method: AppProofMethod },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const basic = Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString("base64");
  let status = 0;
  try {
    const res = await fetchImpl(`${config.issuer.replace(/\/+$/, "")}/api/upstream/app-proof`, {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(input),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    status = res.status;
    const body = (await res.json().catch(() => null)) as { rejected?: { code?: string } } | null;
    const ok = res.ok && !body?.rejected;
    audit({
      actor: `user:${input.legacyUserId}`,
      action: ok ? "app_proof_reported" : "app_proof_report_failed",
      issuer: config.issuer,
      subject: input.sub,
      userId: input.legacyUserId,
      details: { method: input.method, status, rejected: body?.rejected?.code ?? null },
    });
    return ok;
  } catch (e) {
    console.error("[sso] app-proof report failed:", (e as Error).message);
    audit({
      actor: `user:${input.legacyUserId}`,
      action: "app_proof_report_failed",
      issuer: config.issuer,
      subject: input.sub,
      userId: input.legacyUserId,
      details: { method: input.method, status, error: (e as Error).name },
    });
    return false;
  }
}
