/**
 * AIN integration feature flag (ain-integration plan, docs/20-versioning.md):
 * `AIN_INTEGRATION_ENABLED=1|true` turns on the cross-product additions that
 * change what a caller sees on the wire — per-path generations in listings and
 * refs (task 10.2), stale-ref checks on fs/read, request ids on the delegated
 * and shared routes (task 12.5). Off (the default) = the routes answer exactly
 * as before. Read on every call so a test or an operator can flip it.
 *
 * Plain JS (+ .d.ts) so the raw `node server.js` side (agents.js) can read it too.
 */
export function ainIntegrationEnabled(env = process.env) {
  return /^(1|true)$/i.test(String(env.AIN_INTEGRATION_ENABLED ?? "").trim());
}
