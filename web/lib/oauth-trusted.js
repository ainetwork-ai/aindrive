/**
 * Trusted first-party OAuth clients (`AINDRIVE_TRUSTED_OAUTH_CLIENTS`): the
 * operator's own apps (e.g. AIN Teams) whose authorization requests skip the
 * consent screen. Parsing only — the policy lives in lib/oauth.ts
 * (`skipsConsent`) and app/mcp/README.md "Trusted first-party clients".
 *
 * Plain ESM + oauth-trusted.d.ts (lib/README.md ".js + .d.ts" pattern) because
 * boot-checks.js, loaded by `node server.js` without a build, validates the
 * same value.
 *
 * Format: comma-separated entries, each `<client_id>` (any scope the request
 * validly asks for) or `<client_id>=<scope>+<scope>…` (only requests within
 * those scopes skip consent; wider ones get the consent screen as usual).
 * Unset/empty = no trusted client (the behaviour before this existed).
 */

/** Mirrors lib/oauth.ts SCOPES_SUPPORTED (oauth-trusted.test.ts keeps them equal). */
export const KNOWN_OAUTH_SCOPES = Object.freeze([
  "drive:read", "drive:write", "profile", "drives:read", "drives:write", "drives:sell", "wallet:pay",
]);

const CLIENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * @param {string | null | undefined} raw
 * @returns {{ clients: Map<string, string[] | null>, bad: string[] }}
 *   `clients`: client id → its scope ceiling (null = none). `bad`: entries
 *   that are ignored (never trusted) and fail the boot in production.
 */
export function parseTrustedOAuthClients(raw) {
  const clients = new Map();
  const bad = [];
  for (const entry of String(raw ?? "").split(",").map((e) => e.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    const id = (eq < 0 ? entry : entry.slice(0, eq)).trim();
    const scopes = eq < 0 ? null : entry.slice(eq + 1).split(/[+\s]+/).filter(Boolean);
    const scopesOk = scopes === null || (scopes.length > 0 && scopes.every((s) => KNOWN_OAUTH_SCOPES.includes(s)));
    if (!CLIENT_ID.test(id) || !scopesOk || clients.has(id)) {
      bad.push(entry);
      continue;
    }
    clients.set(id, scopes ? [...new Set(scopes)] : null);
  }
  // A client listed twice is ambiguous: trust neither entry.
  for (const entry of bad) {
    const id = entry.split("=")[0].trim();
    if (clients.has(id)) clients.delete(id);
  }
  return { clients, bad };
}

/**
 * Misconfiguration of AINDRIVE_TRUSTED_OAUTH_CLIENTS (production boot rule).
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function trustedOAuthConfigErrors(env) {
  const { bad } = parseTrustedOAuthClients(env.AINDRIVE_TRUSTED_OAUTH_CLIENTS);
  if (!bad.length) return [];
  return [
    `AINDRIVE_TRUSTED_OAUTH_CLIENTS must be comma-separated <client_id> or <client_id>=<scope>+<scope> entries, each client once, scopes from ${KNOWN_OAUTH_SCOPES.join(" ")} (bad: ${bad.join(", ")}).`,
  ];
}
