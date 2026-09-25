/**
 * Account-level OAuth grant — "Sign in with aindrive" for third-party apps.
 *
 * A drive grant (lib/mcp-tokens.ts) is bound to ONE drive; an account grant
 * is bound to the user and carries account scopes (lib/oauth.ts ACCOUNT_SCOPES):
 *   - profile      → GET /api/oauth/userinfo
 *   - drives:read  → GET /api/oauth/drives, and the read tools on `/mcp/d/<id>`
 *                    for any drive the user is a member of
 *   - drives:write → write_file / delete_path there (the user's role must be editor+)
 *   - drives:sell  → the sale tools there, on drives the user created
 * Tokens live in `account_tokens` (lib/db.js): access `aind_aat_…` (1h) +
 * refresh `aind_art_…` (30d), rotated in place on every refresh with the same
 * reuse-revokes-the-grant rule as drive OAuth tokens. Only sha256 hashes are
 * persisted. Like drive tokens, the scope is a ceiling: every MCP call still
 * resolves the user's live role (shared/agent-skills.ts runSkill).
 */
import { nanoid } from "nanoid";
import { db } from "./db";
import { ACCESS_TTL_MS, REFRESH_TTL_MS, hashToken, mint } from "./mcp-tokens";
import { bearerFrom } from "./mcp-http";
import { accountScopeString, parseAccountScopes, type AccountScope } from "./oauth";
import { isWalletOnlyEmail } from "../shared/wallet-display";

export const ACCOUNT_ACCESS_PREFIX = "aind_aat_";
export const ACCOUNT_REFRESH_PREFIX = "aind_art_";
const LAST_USED_THROTTLE_MS = 60 * 1000;

export type AccountTokenRow = {
  id: string;
  user_id: string;
  client_id: string;
  name: string;
  scope: string;
  expires_at: number;
  refresh_expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  created_at: number;
};

export type VerifiedAccountToken = { id: string; userId: string; clientId: string; scopes: AccountScope[] };

export type AccountTokenPair = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
};

export function issueAccountTokens(opts: {
  userId: string;
  clientId: string;
  clientName: string;
  scopes: readonly AccountScope[];
}): AccountTokenPair {
  const access = mint("aind_aat");
  const refresh = mint("aind_art");
  const scope = accountScopeString(opts.scopes);
  const now = Date.now();
  db.prepare(
    `INSERT INTO account_tokens (id, user_id, client_id, name, scope, token_hash, refresh_hash,
                                 expires_at, refresh_expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    nanoid(12), opts.userId, opts.clientId, opts.clientName, scope,
    hashToken(access), hashToken(refresh), now + ACCESS_TTL_MS, now + REFRESH_TTL_MS, now,
  );
  return { access_token: access, refresh_token: refresh, expires_in: ACCESS_TTL_MS / 1000, scope };
}

/**
 * Refresh-token grant: rotate both tokens in place. Presenting a superseded
 * refresh token again means it leaked, so the whole grant is revoked — same
 * rule as refreshOAuthTokens (OAuth 2.1 §4.3.1).
 */
export function refreshAccountTokens(refreshToken: string, clientId: string): AccountTokenPair | null {
  const presented = hashToken(refreshToken);
  const reused = db
    .prepare("UPDATE account_tokens SET revoked_at = ? WHERE prev_refresh_hash = ? AND revoked_at IS NULL")
    .run(Date.now(), presented);
  if (reused.changes > 0) return null;
  const row = db
    .prepare("SELECT id, scope, client_id, refresh_expires_at, revoked_at FROM account_tokens WHERE refresh_hash = ?")
    .get(presented) as
    | { id: string; scope: string; client_id: string; refresh_expires_at: number; revoked_at: number | null }
    | undefined;
  const now = Date.now();
  if (!row || row.revoked_at || row.client_id !== clientId || row.refresh_expires_at < now) return null;
  const access = mint("aind_aat");
  const refresh = mint("aind_art");
  const res = db
    .prepare(
      `UPDATE account_tokens SET token_hash = ?, refresh_hash = ?, prev_refresh_hash = refresh_hash,
                                 expires_at = ?, refresh_expires_at = ?
       WHERE id = ? AND refresh_hash = ?`,
    )
    .run(hashToken(access), hashToken(refresh), now + ACCESS_TTL_MS, now + REFRESH_TTL_MS, row.id, presented);
  if (res.changes !== 1) return null; // lost a concurrent refresh race
  return { access_token: access, refresh_token: refresh, expires_in: ACCESS_TTL_MS / 1000, scope: row.scope };
}

/** Resolve a raw `aind_aat_…` bearer → its grant, or null if unknown/expired/revoked. */
export function verifyAccountToken(raw: string): VerifiedAccountToken | null {
  if (!raw.startsWith(ACCOUNT_ACCESS_PREFIX)) return null;
  const row = db
    .prepare("SELECT id, user_id, client_id, scope, expires_at, revoked_at, last_used_at FROM account_tokens WHERE token_hash = ?")
    .get(hashToken(raw)) as
    | Pick<AccountTokenRow, "id" | "user_id" | "client_id" | "scope" | "expires_at" | "revoked_at" | "last_used_at">
    | undefined;
  const now = Date.now();
  if (!row || row.revoked_at || row.expires_at < now) return null;
  if (!row.last_used_at || now - row.last_used_at > LAST_USED_THROTTLE_MS) {
    db.prepare("UPDATE account_tokens SET last_used_at = ? WHERE id = ?").run(now, row.id);
  }
  return { id: row.id, userId: row.user_id, clientId: row.client_id, scopes: parseAccountScopes(row.scope) };
}

const LIST_COLS = "id, user_id, client_id, name, scope, expires_at, refresh_expires_at, last_used_at, revoked_at, created_at";

export function getAccountToken(id: string): AccountTokenRow | null {
  return (db.prepare(`SELECT ${LIST_COLS} FROM account_tokens WHERE id = ?`).get(id) as AccountTokenRow) ?? null;
}

/** The user's connected apps: not revoked, refresh token still alive. */
export function listAccountTokens(userId: string): AccountTokenRow[] {
  return db
    .prepare(
      `SELECT ${LIST_COLS} FROM account_tokens
       WHERE user_id = ? AND revoked_at IS NULL AND refresh_expires_at > ?
       ORDER BY created_at DESC`,
    )
    .all(userId, Date.now()) as AccountTokenRow[];
}

/** Revoke one of the user's own grants. False if not theirs or already revoked. */
export function revokeAccountToken(userId: string, id: string): boolean {
  return db
    .prepare("UPDATE account_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .run(Date.now(), id, userId).changes === 1;
}

// ── What the grant exposes ───────────────────────────────────────────────

export type AccountUserinfo = {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
  wallet_address: string | null;
};

/**
 * Wallet-provisioned accounts (`w_…`, lib/wallet.ts resolveAccountForWallet)
 * carry a synthetic `<address>@wallet.aindrive.local` email — the address is
 * its local part. Otherwise (email accounts, or a wallet account that later
 * attached a real email) it is the first linked wallet, which for a `w_`
 * account is the one minted with it.
 */
function walletAddressFor(user: { id: string; email: string }): string | null {
  if (isWalletOnlyEmail(user.email)) {
    const local = user.email.slice(0, user.email.indexOf("@")).toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(local)) return local;
  }
  const row = db
    .prepare("SELECT wallet_address FROM account_wallets WHERE account_id = ? ORDER BY linked_at ASC, rowid ASC LIMIT 1")
    .get(user.id) as { wallet_address: string } | undefined;
  return row ? row.wallet_address.toLowerCase() : null;
}

/**
 * Userinfo for the `profile` scope. Every real email is OTP-verified before it
 * lands on an account (signup, attach-email), so email_verified is false only
 * for the synthetic wallet placeholder — which callers must not display.
 */
export function accountUserinfo(userId: string): AccountUserinfo | null {
  const user = db.prepare("SELECT id, email, name FROM users WHERE id = ?").get(userId) as
    | { id: string; email: string; name: string }
    | undefined;
  if (!user) return null;
  return {
    sub: user.id,
    email: user.email,
    email_verified: !isWalletOnlyEmail(user.email),
    name: user.name,
    wallet_address: walletAddressFor(user),
  };
}

// ── Bearer auth for the account API routes (/api/oauth/userinfo, /drives) ──

export const ACCOUNT_API_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Expose-Headers": "WWW-Authenticate",
  "Cache-Control": "no-store",
  Pragma: "no-cache",
};

/**
 * Authenticate an account-API request: a live `aind_aat_…` bearer holding
 * `need`. On failure returns the RFC 6750 response to send as-is: 401 +
 * WWW-Authenticate for a missing/bad/expired token, 403 insufficient_scope
 * when the grant lacks `need`.
 */
export function authenticateAccountRequest(
  req: Request,
  need: AccountScope,
): { ok: true; token: VerifiedAccountToken } | { ok: false; response: Response } {
  const bearer = bearerFrom(req);
  const token = bearer ? verifyAccountToken(bearer) : null;
  if (!token) {
    const description = bearer ? "token is invalid, expired or revoked" : "missing bearer token";
    return {
      ok: false,
      response: Response.json(
        { error: "invalid_token", error_description: description },
        {
          status: 401,
          headers: { ...ACCOUNT_API_HEADERS, "WWW-Authenticate": `Bearer error="invalid_token", error_description="${description}"` },
        },
      ),
    };
  }
  if (!token.scopes.includes(need)) {
    const description = `this endpoint needs the ${need} scope`;
    return {
      ok: false,
      response: Response.json(
        { error: "insufficient_scope", error_description: description },
        {
          status: 403,
          headers: {
            ...ACCOUNT_API_HEADERS,
            "WWW-Authenticate": `Bearer error="insufficient_scope", error_description="${description}", scope="${need}"`,
          },
        },
      ),
    };
  }
  return { ok: true, token };
}
