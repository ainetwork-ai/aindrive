/**
 * Trusted first-party OAuth clients (`AINDRIVE_TRUSTED_OAUTH_CLIENTS`): the
 * operator's own apps (e.g. AIN Teams) whose authorization requests skip the
 * consent screen. Parsing only — the policy lives in lib/oauth.ts
 * (`skipsConsent`), lib/oauth-authorize.ts and app/mcp/README.md "Trusted
 * first-party clients".
 *
 * Plain ESM + oauth-trusted.d.ts (lib/README.md ".js + .d.ts" pattern) because
 * boot-checks.js, loaded by `node server.js` without a build, validates the
 * same value.
 *
 * Format: comma-separated `<client_id>=<scope>+<scope>…` entries. The scopes
 * are the ceiling: only requests within them skip consent, wider ones get the
 * consent screen as usual. The ceiling is required — a bare `<client_id>`
 * would let any scope skip consent — and may not name a scope that moves money
 * (`wallet:pay`, `drives:sell`): those always need the person's click.
 * Unset/empty = no trusted client (the behaviour before this existed).
 */

/** Mirrors lib/oauth.ts SCOPES_SUPPORTED (oauth-trusted.test.ts keeps them equal). */
export const KNOWN_OAUTH_SCOPES = Object.freeze([
  "drive:read", "drive:write", "profile", "drives:read", "drives:write", "drives:share", "drives:sell", "wallet:pay",
]);

/** Payment and sale authority: never granted without the consent screen, whatever the list says. */
export const CONSENT_ALWAYS_SCOPES = Object.freeze(["wallet:pay", "drives:sell"]);

const CLIENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * @param {string | null | undefined} raw
 * @returns {{ clients: Map<string, string[]>, bad: string[] }}
 *   `clients`: client id → its scope ceiling. `bad`: entries that are ignored
 *   (never trusted) and fail the boot in production.
 */
export function parseTrustedOAuthClients(raw) {
  const clients = new Map();
  const bad = [];
  for (const entry of String(raw ?? "").split(",").map((e) => e.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    const id = (eq < 0 ? entry : entry.slice(0, eq)).trim();
    const scopes = eq < 0 ? [] : entry.slice(eq + 1).split(/[+\s]+/).filter(Boolean);
    const scopesOk = scopes.length > 0
      && scopes.every((s) => KNOWN_OAUTH_SCOPES.includes(s) && !CONSENT_ALWAYS_SCOPES.includes(s));
    if (!CLIENT_ID.test(id) || !scopesOk || clients.has(id)) {
      bad.push(entry);
      continue;
    }
    clients.set(id, [...new Set(scopes)]);
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
  const allowed = KNOWN_OAUTH_SCOPES.filter((s) => !CONSENT_ALWAYS_SCOPES.includes(s));
  return [
    `AINDRIVE_TRUSTED_OAUTH_CLIENTS must be comma-separated <client_id>=<scope>+<scope> entries (the scope ceiling is required), each client once, scopes from ${allowed.join(" ")} — ${CONSENT_ALWAYS_SCOPES.join(" and ")} always need consent (bad: ${bad.join(", ")}).`,
  ];
}
