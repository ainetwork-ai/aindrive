/**
 * OAuth 2.1 authorization server for the remote MCP endpoint, per the MCP
 * authorization spec: RFC 8414 AS metadata, RFC 9728 protected-resource
 * metadata, RFC 7591 dynamic client registration, authorization code + PKCE
 * (S256 only), refresh-token rotation. Public clients only — no client
 * secrets. Tokens themselves live in lib/mcp-tokens.ts.
 *
 * Two kinds of grant:
 *   - drive   — `resource` = mcpUrlFor(driveId) (RFC 8707); scope wire format
 *               "drive:read" | "drive:write" ↔ McpScope "read"|"write".
 *   - account — NO `resource`, only account scopes (ACCOUNT_SCOPES);
 *               "Sign in with aindrive" for third-party apps. Codes/tokens
 *               live in account_oauth_codes / lib/account-tokens.ts.
 */
import { createHash, randomBytes } from "node:crypto";
import { db } from "./db";
import { env } from "./env";
import { hashToken, mcpUrlFor, type McpScope } from "./mcp-tokens";

export const CODE_TTL_MS = 10 * 60 * 1000;
export const DRIVE_SCOPES = ["drive:read", "drive:write"] as const;
/**
 * Account grant scopes: profile → /api/oauth/userinfo; drives:read →
 * /api/oauth/drives + the read tools on /mcp/d/*; drives:write → write_file /
 * delete_path there (role editor+); drives:sell → the owner-only sale tools;
 * wallet:pay → the x402 pay tools (the account's agent wallet signs, the
 * server's facilitator settles), when the server has agent wallets on.
 */
export const ACCOUNT_SCOPES = ["profile", "drives:read", "drives:write", "drives:sell", "wallet:pay"] as const;
export type AccountScope = (typeof ACCOUNT_SCOPES)[number];
export const SCOPES_SUPPORTED = [...DRIVE_SCOPES, ...ACCOUNT_SCOPES] as const;

export function baseUrl(): string {
  return env.publicUrl.replace(/\/$/, "");
}

export function authServerMetadata() {
  const base = baseUrl();
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    userinfo_endpoint: `${base}/api/oauth/userinfo`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...SCOPES_SUPPORTED],
  };
}

export function protectedResourceMetadata(driveId: string, driveName: string) {
  return {
    resource: mcpUrlFor(driveId),
    authorization_servers: [baseUrl()],
    scopes_supported: [...DRIVE_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: `aindrive — ${driveName}`,
  };
}

/** "drive:read drive:write" → the widest requested McpScope (default read). */
export function parseScope(raw: string | null | undefined): McpScope {
  const parts = (raw ?? "").split(/\s+/);
  return parts.includes("drive:write") ? "write" : "read";
}

export function scopeString(scope: McpScope): string {
  return scope === "write" ? "drive:read drive:write" : "drive:read";
}

/** Known account scopes in `raw`, deduped, in canonical order. */
export function parseAccountScopes(raw: string | null | undefined): AccountScope[] {
  const parts = (raw ?? "").split(/\s+/);
  return ACCOUNT_SCOPES.filter((s) => parts.includes(s));
}

/** Account scope wire format, canonical order: ["drives:read","profile"] → "profile drives:read". */
export function accountScopeString(scopes: readonly AccountScope[]): string {
  return ACCOUNT_SCOPES.filter((s) => scopes.includes(s)).join(" ");
}

/** resource URL → driveId, only for this server's `/mcp/d/<id>` URLs. */
export function driveIdFromResource(resource: string | null | undefined): string | null {
  if (!resource) return null;
  let u: URL;
  try { u = new URL(resource); } catch { return null; }
  if (u.origin !== new URL(baseUrl()).origin) return null;
  const m = u.pathname.replace(/\/$/, "").match(/^\/mcp\/d\/([A-Za-z0-9_-]+)$/);
  return m ? m[1] : null;
}

/**
 * CSRF guard for cookie-authenticated mutations (consent decision, PAT
 * issue/revoke): the browser-sent Origin must be this server.
 */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  if (origin === new URL(baseUrl()).origin) return true;
  try { return new URL(origin).host === req.headers.get("host"); } catch { return false; }
}

// ── Dynamic client registration ─────────────────────────────────────────

export type OAuthClient = { client_id: string; client_name: string; redirect_uris: string[] };

/**
 * Redirect URIs: https anywhere, http only on loopback (native/CLI clients),
 * or a private-use scheme (cursor://, vscode://…). Never javascript:/data:/
 * file:, and no fragments (RFC 6749 §3.1.2).
 */
export function isAllowedRedirectUri(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.hash) return false;
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  if (scheme === "https") return true;
  if (scheme === "http") {
    if (["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return true;
    // Dev only: let a client on another machine (e.g. a LAN IP) round-trip
    // the flow against a local server. Never honoured in production.
    return process.env.NODE_ENV !== "production" && process.env.AINDRIVE_DEV_ALLOW_HTTP_REDIRECTS === "1";
  }
  if (["javascript", "data", "file", "blob", "vbscript", "about", "ftp", "ws", "wss", "intent", "filesystem", "view-source"].includes(scheme)) return false;
  return /^[a-z][a-z0-9+.-]*$/.test(scheme);
}

/**
 * Housekeeping, run on registration: drop codes past expiry by a day, and
 * registrations older than a week that never obtained a token (abandoned or
 * spam DCR). Keeps both tables bounded without a scheduler.
 */
export function gcOAuth(now = Date.now()) {
  db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").run(now - 24 * 60 * 60 * 1000);
  db.prepare("DELETE FROM account_oauth_codes WHERE expires_at < ?").run(now - 24 * 60 * 60 * 1000);
  db.prepare(
    `DELETE FROM oauth_clients WHERE created_at < ?
       AND client_id NOT IN (SELECT client_id FROM mcp_tokens WHERE client_id IS NOT NULL)
       AND client_id NOT IN (SELECT client_id FROM account_tokens)`,
  ).run(now - 7 * 24 * 60 * 60 * 1000);
}

export function registerClient(clientName: string, redirectUris: string[]): OAuthClient {
  gcOAuth();
  const clientId = `aind_client_${randomBytes(16).toString("base64url")}`;
  db.prepare(
    "INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)",
  ).run(clientId, clientName, JSON.stringify(redirectUris), Date.now());
  return { client_id: clientId, client_name: clientName, redirect_uris: redirectUris };
}

export function getClient(clientId: string | null | undefined): OAuthClient | null {
  if (!clientId) return null;
  const row = db
    .prepare("SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?")
    .get(clientId) as { client_id: string; client_name: string; redirect_uris: string } | undefined;
  if (!row) return null;
  return { client_id: row.client_id, client_name: row.client_name, redirect_uris: JSON.parse(row.redirect_uris) };
}

// ── Authorization request validation (shared by consent page + POST) ────

export type AuthorizeParams = {
  response_type?: string | null;
  client_id?: string | null;
  redirect_uri?: string | null;
  code_challenge?: string | null;
  code_challenge_method?: string | null;
  scope?: string | null;
  state?: string | null;
  resource?: string | null;
};

type ValidAuthorizeBase = {
  client: OAuthClient;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
};

/** driveId set → drive grant (MCP); driveId null → account grant. */
export type ValidAuthorize =
  | (ValidAuthorizeBase & { driveId: string; requestedScope: McpScope })
  | (ValidAuthorizeBase & { driveId: null; accountScopes: AccountScope[] });

const ACCOUNT_SCOPE_LIST = ACCOUNT_SCOPES.join(", ");
const MISSING_RESOURCE =
  "Missing or unknown `resource` — use the drive's MCP URL (…/mcp/d/<driveId>), " +
  `or omit it and request only account scopes (${ACCOUNT_SCOPE_LIST}).`;

/**
 * Scope of a request WITHOUT `resource` (account grant): strict — only
 * account scopes, at least one. Drive requests keep the lenient parseScope.
 */
function accountScopesFrom(raw: string | null | undefined): { ok: true; scopes: AccountScope[] } | { ok: false; error: string } {
  const parts = (raw ?? "").split(/\s+/).filter(Boolean);
  const unknown = parts.filter((s) => !(SCOPES_SUPPORTED as readonly string[]).includes(s));
  if (unknown.length) return { ok: false, error: `Unknown scope: ${unknown.join(" ")}.` };
  const scopes = parseAccountScopes(raw);
  if (scopes.length === 0) return { ok: false, error: MISSING_RESOURCE };
  if (scopes.length !== new Set(parts).size) {
    return { ok: false, error: `drive:read / drive:write need a drive \`resource\` and can't be combined with account scopes (${ACCOUNT_SCOPE_LIST}).` };
  }
  return { ok: true, scopes };
}

/**
 * Validate an authorization request. Errors are returned (never redirected):
 * until client_id + redirect_uri check out we must not redirect at all, and
 * the consent page simply renders the message for the rest.
 */
export function validateAuthorize(p: AuthorizeParams): { ok: true; value: ValidAuthorize } | { ok: false; error: string } {
  const client = getClient(p.client_id);
  if (!client) return { ok: false, error: "Unknown client_id. The app must register first." };
  if (!p.redirect_uri || !client.redirect_uris.includes(p.redirect_uri)) {
    return { ok: false, error: "redirect_uri does not match the registered client." };
  }
  if (p.response_type !== "code") return { ok: false, error: "response_type must be 'code'." };
  if (!p.code_challenge || p.code_challenge_method !== "S256") {
    return { ok: false, error: "PKCE with code_challenge_method=S256 is required." };
  }
  const base = { client, redirectUri: p.redirect_uri, codeChallenge: p.code_challenge, state: p.state ?? null };
  if (!p.resource) {
    const account = accountScopesFrom(p.scope);
    if (!account.ok) return { ok: false, error: account.error };
    return { ok: true, value: { ...base, driveId: null, accountScopes: account.scopes } };
  }
  const driveId = driveIdFromResource(p.resource);
  if (!driveId) return { ok: false, error: MISSING_RESOURCE };
  return { ok: true, value: { ...base, driveId, requestedScope: parseScope(p.scope) } };
}

export function redirectWith(redirectUri: string, params: Record<string, string | null>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  u.searchParams.set("iss", baseUrl()); // RFC 9207 mix-up defense
  return u.toString();
}

// ── Authorization codes ──────────────────────────────────────────────────

export function issueCode(opts: {
  clientId: string;
  userId: string;
  driveId: string;
  scope: McpScope;
  redirectUri: string;
  codeChallenge: string;
}): string {
  const code = randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare(
    `INSERT INTO oauth_codes (code_hash, client_id, user_id, drive_id, scope, redirect_uri, code_challenge, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(hashToken(code), opts.clientId, opts.userId, opts.driveId, opts.scope, opts.redirectUri, opts.codeChallenge, now + CODE_TTL_MS, now);
  return code;
}

export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export type RedeemedCode = { userId: string; driveId: string; scope: McpScope };

type RedeemOpts = { code: string; clientId: string; redirectUri: string; codeVerifier: string };

/** Expiry, client/redirect binding and PKCE — shared by both code kinds. */
function codeMatches(
  row: { client_id: string; redirect_uri: string; code_challenge: string; expires_at: number },
  opts: RedeemOpts,
): boolean {
  if (row.expires_at < Date.now()) return false;
  if (row.client_id !== opts.clientId || row.redirect_uri !== opts.redirectUri) return false;
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(opts.codeVerifier)) return false;
  return pkceS256(opts.codeVerifier) === row.code_challenge;
}

/**
 * One-time exchange. The code is burned (consumed=1) BEFORE the checks so a
 * failed or replayed attempt can never be retried with a different verifier.
 */
export function redeemCode(opts: RedeemOpts): RedeemedCode | null {
  const hash = hashToken(opts.code);
  const burned = db.prepare("UPDATE oauth_codes SET consumed = 1 WHERE code_hash = ? AND consumed = 0").run(hash);
  if (burned.changes !== 1) return null;
  const row = db
    .prepare("SELECT client_id, user_id, drive_id, scope, redirect_uri, code_challenge, expires_at FROM oauth_codes WHERE code_hash = ?")
    .get(hash) as {
      client_id: string; user_id: string; drive_id: string; scope: McpScope;
      redirect_uri: string; code_challenge: string; expires_at: number;
    };
  if (!codeMatches(row, opts)) return null;
  return { userId: row.user_id, driveId: row.drive_id, scope: row.scope };
}

// ── Account-grant codes (no drive; see lib/account-tokens.ts) ────────────

export function issueAccountCode(opts: {
  clientId: string;
  userId: string;
  scopes: readonly AccountScope[];
  redirectUri: string;
  codeChallenge: string;
}): string {
  const code = randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare(
    `INSERT INTO account_oauth_codes (code_hash, client_id, user_id, scope, redirect_uri, code_challenge, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(hashToken(code), opts.clientId, opts.userId, accountScopeString(opts.scopes), opts.redirectUri, opts.codeChallenge, now + CODE_TTL_MS, now);
  return code;
}

export type RedeemedAccountCode = { userId: string; scopes: AccountScope[] };

/** redeemCode for account codes: same burn-first one-time exchange. */
export function redeemAccountCode(opts: RedeemOpts): RedeemedAccountCode | null {
  const hash = hashToken(opts.code);
  const burned = db.prepare("UPDATE account_oauth_codes SET consumed = 1 WHERE code_hash = ? AND consumed = 0").run(hash);
  if (burned.changes !== 1) return null;
  const row = db
    .prepare("SELECT client_id, user_id, scope, redirect_uri, code_challenge, expires_at FROM account_oauth_codes WHERE code_hash = ?")
    .get(hash) as {
      client_id: string; user_id: string; scope: string;
      redirect_uri: string; code_challenge: string; expires_at: number;
    };
  if (!codeMatches(row, opts)) return null;
  return { userId: row.user_id, scopes: parseAccountScopes(row.scope) };
}
