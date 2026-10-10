import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../drizzle/schema.js";

function dataDir() {
  const dir = process.env.AINDRIVE_DATA_DIR || join(homedir(), ".aindrive");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function open() {
  const path = join(dataDir(), "data.sqlite");
  const handle = new Database(path);
  handle.pragma("journal_mode = WAL");
  handle.pragma("foreign_keys = ON");
  if (process.env.AINDRIVE_SQLITE_NO_WAL !== "1") {
    handle.pragma("synchronous = NORMAL");
    handle.pragma("busy_timeout = 5000");
  }
  handle.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS drives (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      agent_token_hash TEXT NOT NULL,
      drive_secret TEXT NOT NULL,
      last_seen_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      payout_wallet TEXT,
      FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS drive_members (
      id TEXT PRIMARY KEY,
      drive_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(drive_id, user_id, path),
      FOREIGN KEY(drive_id) REFERENCES drives(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY,
      drive_id TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      currency TEXT,
      FOREIGN KEY(drive_id) REFERENCES drives(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS cli_link_requests (
      link_id TEXT PRIMARY KEY,
      device_secret_hash TEXT NOT NULL,
      user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS payment_receipts (
      id TEXT PRIMARY KEY,
      drive_id TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '',
      wallet TEXT NOT NULL,
      tx_hash TEXT NOT NULL UNIQUE,
      -- nullable: NULL means "amount unknown" (legacy backfilled receipts
      -- from before Phase 4 don't carry the original amount). A real 0
      -- amount is a different signal from "we don't know."
      amount_usdc REAL,
      -- Token symbol the sale was priced/paid in (mirrors shares.currency).
      -- amount_usdc is in THIS unit, not USD. NULL only on legacy pre-currency
      -- rows before the backfill below; the write path always records it.
      currency TEXT,
      network TEXT NOT NULL,
      share_id TEXT,
      settled_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(drive_id) REFERENCES drives(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_cli_link_expires ON cli_link_requests(expires_at);
    CREATE INDEX IF NOT EXISTS idx_drive_members_user ON drive_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_drive_members_drive ON drive_members(drive_id);
    CREATE INDEX IF NOT EXISTS idx_shares_drive ON shares(drive_id);
    CREATE INDEX IF NOT EXISTS idx_payment_receipts_wallet ON payment_receipts(wallet);
    CREATE INDEX IF NOT EXISTS idx_payment_receipts_drive_wallet ON payment_receipts(drive_id, wallet);
    CREATE TABLE IF NOT EXISTS account_wallets (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      wallet_address TEXT NOT NULL UNIQUE,
      linked_at TEXT NOT NULL DEFAULT (datetime('now')),
      verified_via TEXT NOT NULL DEFAULT 'siwe',
      FOREIGN KEY(account_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_account_wallets_account ON account_wallets(account_id);
    -- Google sign-in: the Google account (sub) that reaches an aindrive account.
    CREATE TABLE IF NOT EXISTS account_google (
      sub TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      email TEXT NOT NULL,
      linked_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(account_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_account_google_account ON account_google(account_id);
    -- File handoff links: one file, picked on the owner's device, readable by an outside agent
    -- through a short-lived URL. Bytes come from the device (carrier drive's agent), never stored here.
    CREATE TABLE IF NOT EXISTS file_handoffs (
      id TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      drive_id TEXT NOT NULL,
      device_key TEXT NOT NULL,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      audience TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_file_handoffs_owner ON file_handoffs(owner_id, created_at);
    CREATE TABLE IF NOT EXISTS file_handoff_fetches (
      handoff_id TEXT NOT NULL,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      ip TEXT,
      user_agent TEXT,
      status INTEGER NOT NULL,
      FOREIGN KEY(handoff_id) REFERENCES file_handoffs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_file_handoff_fetches ON file_handoff_fetches(handoff_id);
    -- One grant per handoff batch: the MCP view (/mcp/h/<id>) of exactly the files handed off
    -- together. Its bearer secret is kept as a hash; the files' own expiry/revocation still apply.
    CREATE TABLE IF NOT EXISTS handoff_grants (
      id TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      audience TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    -- Invites for emails that don't have an account yet. On signup these convert
    -- to drive_members (upgrade-only) and are deleted; a registered invitee is
    -- granted immediately and never lands here. UNIQUE keeps one pending grant
    -- per (drive, email, path) — re-invite overwrites the role.
    CREATE TABLE IF NOT EXISTS drive_invites (
      id TEXT PRIMARY KEY,
      drive_id TEXT NOT NULL,
      email TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(drive_id, email, path),
      FOREIGN KEY(drive_id) REFERENCES drives(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_drive_invites_email ON drive_invites(email);
    CREATE INDEX IF NOT EXISTS idx_drive_invites_drive ON drive_invites(drive_id);
    -- Path-scoped payout wallets. A paid share's funds go to the wallet of the
    -- nearest ANCESTOR path (same inheritance as drive_members roles): e.g. a
    -- sale under artists/alice/ uses artists/alice's wallet, else artists', else
    -- the root ("") wallet. drives.payout_wallet is migrated into the "" row.
    CREATE TABLE IF NOT EXISTS drive_payout_wallets (
      id TEXT PRIMARY KEY,
      drive_id TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '',
      wallet TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(drive_id, path),
      FOREIGN KEY(drive_id) REFERENCES drives(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_drive_payout_drive ON drive_payout_wallets(drive_id);
    -- Chunked/resumable upload sessions (lib/upload-sessions.ts). One row per
    -- in-flight upload: the client PATCHes sequential parts against
    -- received_bytes (tus-style offset check) into temp_path on the agent,
    -- and the final part triggers the atomic rename onto path.
    CREATE TABLE IF NOT EXISTS upload_sessions (
      id TEXT PRIMARY KEY,
      drive_id TEXT NOT NULL,
      path TEXT NOT NULL,
      temp_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      received_bytes INTEGER NOT NULL DEFAULT 0,
      is_creating INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(drive_id) REFERENCES drives(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_upload_sessions_drive ON upload_sessions(drive_id);
  `);
  // payment_chain → currency rename. Must run BEFORE the ADD loop: on a fresh
  // DB the CREATE above already made `currency`, so adding payment_chain first
  // would make this rename throw "duplicate column" on every first boot.
  // Ignore "no such column" (fresh DB / already renamed) and "duplicate
  // column" (half-state where both somehow exist).
  try {
    handle.exec("ALTER TABLE shares RENAME COLUMN payment_chain TO currency");
  } catch (e) {
    if (!/no such column|duplicate column/i.test(e.message)) throw e;
  }
  // Idempotent ALTERs (better-sqlite3 has no IF NOT EXISTS for ALTER)
  for (const stmt of [
    "ALTER TABLE shares ADD COLUMN price_usdc REAL",
    // covers pre-payment_chain DBs that the rename above skipped
    "ALTER TABLE shares ADD COLUMN currency TEXT",
    "ALTER TABLE shares ADD COLUMN listed INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE drives ADD COLUMN allowed_tokens TEXT",
    "ALTER TABLE drives ADD COLUMN namespace_pubkey BLOB",
    "ALTER TABLE drives ADD COLUMN namespace_secret BLOB",
    "ALTER TABLE drives ADD COLUMN last_hostname TEXT",
    // 1 = rotate this drive's agent credentials live when its agent is online
    // (lib/agents.js rotateAgentLive). Cleared by a successful live or manual rotation.
    "ALTER TABLE drives ADD COLUMN rotation_pending INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE drives ADD COLUMN payout_wallet TEXT",
    "ALTER TABLE payment_receipts ADD COLUMN account_id TEXT",
    "ALTER TABLE payment_receipts ADD COLUMN currency TEXT",
    "ALTER TABLE account_wallets ADD COLUMN login_enabled INTEGER NOT NULL DEFAULT 0",
    // the app that started a sign-in pairing (null = the aindrive CLI) — only
    // to word the approval page; self-reported, never trusted for access
    "ALTER TABLE cli_link_requests ADD COLUMN client_name TEXT",
    // the handoff_grants row a link was minted in (null: minted before grants existed)
    "ALTER TABLE file_handoffs ADD COLUMN grant_id TEXT",
    // a handoff made on the web (Folder Chat → a cloud agent) names the file by its drive path;
    // its bytes come over download-chunk instead of the device's handoff-read
    "ALTER TABLE file_handoffs ADD COLUMN drive_path TEXT",
  ]) {
    try { handle.exec(stmt); } catch (e) {
      if (!/duplicate column/i.test(e.message)) throw e;
    }
  }
  // Index on payment_receipts(account_id) added after the ALTER that creates
  // the column (CREATE INDEX IF NOT EXISTS is safe to run every startup).
  handle.exec(`
    CREATE INDEX IF NOT EXISTS idx_payment_receipts_account ON payment_receipts(account_id);
  `);
  // Backfill currency on receipts predating the column: inherit the originating
  // share's currency; fall back to 'USDC' when the share is gone or its currency
  // is NULL (pre-policy sales were all USDC). WHERE currency IS NULL makes this
  // a one-time migration — new receipts carry currency from the write path.
  handle.exec(`
    UPDATE payment_receipts
    SET currency = COALESCE((SELECT s.currency FROM shares s WHERE s.id = share_id), 'USDC')
    WHERE currency IS NULL;
  `);
  // x402 settle attempts of AUTHENTICATED accounts paying an EIP-3009 paid
  // share (lib/x402-account-settlements.js, docs/X402_PAYMENT_PENDING.md). A
  // row is written after facilitator verify and right before settle, with a
  // snapshot of the sale. One authorization (network, asset, payer, nonce)
  // belongs to one account and one sale forever. status: 'unresolved' (settle
  // outcome not known — blocks a NEW authorization by the same account for the
  // same sale), 'credited' (this server's settle answered success, or support
  // credited it), 'released' (settle refused before broadcast, or support
  // released it). Nothing reads the chain to change a row; the support CLI
  // (scripts/x402-settlements.mjs) resolves stuck rows, logged in _events.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS x402_account_settlements (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      share_id TEXT NOT NULL,
      drive_id TEXT NOT NULL,
      path TEXT NOT NULL,
      role TEXT NOT NULL,
      amount_usdc REAL NOT NULL,
      currency TEXT NOT NULL,
      chain TEXT NOT NULL,
      pay_to TEXT NOT NULL,
      amount_atomic TEXT NOT NULL,
      network TEXT NOT NULL,
      asset TEXT NOT NULL,
      payer TEXT NOT NULL,
      nonce TEXT NOT NULL,
      envelope_hash TEXT NOT NULL,
      valid_before TEXT,
      status TEXT NOT NULL DEFAULT 'unresolved' CHECK (status IN ('unresolved', 'credited', 'released')),
      tx_hash TEXT,
      last_error TEXT,
      resolved_by TEXT,
      resolution_note TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (network, asset, payer, nonce)
    );
    CREATE INDEX IF NOT EXISTS idx_x402_account_settlements_sale
      ON x402_account_settlements(account_id, status, drive_id, path, role);
    CREATE INDEX IF NOT EXISTS idx_x402_account_settlements_tx ON x402_account_settlements(tx_hash);
    CREATE TABLE IF NOT EXISTS x402_account_settlement_events (
      id TEXT PRIMARY KEY,
      settlement_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      detail TEXT,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_x402_account_settlement_events_row ON x402_account_settlement_events(settlement_id, at);
  `);
  // Email OTP codes (lib/otp) — password reset now, reusable for signup/email
  // verification later. code_hash = sha256(`${salt}:${code}`); times are epoch
  // ms. One active (consumed=0, unexpired) row per (email, purpose) matters —
  // issue invalidates prior ones.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS email_verification_codes (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      purpose TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      consumed INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      verified_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evc_email_purpose ON email_verification_codes(email, purpose, created_at);
  `);
  // Sponsored-gas accounting (lib/paymaster): one row per grant actually turned
  // into sponsorship. `jti` PRIMARY KEY makes a grant one-time (replay = INSERT
  // conflict); created_at (epoch ms) drives the rolling 24h global + per-user
  // spend caps that bound paymaster-budget drain in-app (CDP portal cap is the
  // out-of-band backstop).
  handle.exec(`
    CREATE TABLE IF NOT EXISTS sponsored_ops (
      jti TEXT PRIMARY KEY,
      user_id TEXT,
      wallet TEXT NOT NULL,
      token TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sponsored_ops_created ON sponsored_ops(created_at);
    CREATE INDEX IF NOT EXISTS idx_sponsored_ops_user ON sponsored_ops(user_id, created_at);
  `);
  // Remote MCP auth (lib/mcp-tokens, lib/oauth). mcp_tokens holds BOTH manually
  // issued personal access tokens (kind='pat') and OAuth-issued access/refresh
  // pairs (kind='oauth', one row per connected app, rotated in place). Only
  // sha256 hashes are stored; every token is scoped to ONE drive + a scope
  // ('read'|'write') that is clamped against the user's live role per call.
  // oauth_clients = RFC 7591 dynamic registrations (public clients, PKCE only);
  // oauth_codes = one-time authorization codes (10 min). Times are epoch ms.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS mcp_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      drive_id TEXT NOT NULL,
      name TEXT NOT NULL,
      scope TEXT NOT NULL,
      kind TEXT NOT NULL,
      client_id TEXT,
      token_hash TEXT NOT NULL UNIQUE,
      refresh_hash TEXT UNIQUE,
      prev_refresh_hash TEXT,
      expires_at INTEGER,
      refresh_expires_at INTEGER,
      last_used_at INTEGER,
      revoked_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(drive_id) REFERENCES drives(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_tokens_drive ON mcp_tokens(drive_id, user_id);
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY,
      client_name TEXT NOT NULL,
      redirect_uris TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      drive_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(drive_id) REFERENCES drives(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
  try {
    handle.exec("ALTER TABLE mcp_tokens ADD COLUMN prev_refresh_hash TEXT");
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }
  // Account-level OAuth grant (lib/account-tokens, lib/oauth): "Sign in with
  // aindrive" for third-party apps — one token pair covering the user, not one
  // drive. Separate tables so mcp_tokens/oauth_codes keep drive_id NOT NULL.
  // scope is a space-separated string of account scopes ("profile drives:read").
  // Access `aind_aat_…` (1h) + refresh `aind_art_…` (30d, rotated in place,
  // reuse of a superseded refresh revokes the row). Only sha256 hashes; epoch ms.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS account_oauth_codes (
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS account_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      name TEXT NOT NULL,
      scope TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      refresh_hash TEXT NOT NULL UNIQUE,
      prev_refresh_hash TEXT,
      expires_at INTEGER NOT NULL,
      refresh_expires_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_account_tokens_user ON account_tokens(user_id);
    -- Agent wallets (lib/agent-wallets.ts): a custodial pocket-money key per
    -- account for x402 payments an agent makes as that account. Not the
    -- identity wallet (account_wallets). key_enc is AES-GCM under the session secret.
    CREATE TABLE IF NOT EXISTS agent_wallets (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL UNIQUE,
      address TEXT NOT NULL UNIQUE,
      key_enc TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(account_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_account_tokens_prev_refresh ON account_tokens(prev_refresh_hash);
    -- Connected apps (lib/connected-apps.ts): another app (e.g. ainmem) that a
    -- person's folders can be shared into, per folder, from the share sheet.
    -- The app registers itself on the account with its spaces URL and a key
    -- this server sends back as a Bearer when it lists or toggles spaces.
    CREATE TABLE IF NOT EXISTS connected_apps (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      origin TEXT NOT NULL,
      spaces_url TEXT NOT NULL,
      app_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, origin),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
  // AIN SSO (lib/sso/README.md). Additive only: new tables + nullable/defaulted
  // columns, safe to run on every boot. With no AINDRIVE_SSO_* configuration
  // these stay empty and nothing reads them to a different result.
  //   sso_identities   — the AIN account (issuer, subject) that reaches an aindrive
  //                      account. Linked by a verified sub only, never by email.
  //   sso_memberships  — per-(org, sub) state pushed by the provisioning adapter;
  //                      an account with rows here and none `active` is blocked on
  //                      every sign-in path (survives every LEGACY_LOGIN setting).
  //   sso_sessions     — server-side rows for SSO sign-ins, keyed by the OIDC sid
  //                      so back-channel logout can end them.
  //   sso_login_requests / sso_pending_links — short-lived sign-in state (state,
  //                      nonce, PKCE verifier; a verified login awaiting "connect
  //                      or create"). Times are epoch ms.
  //   sso_replay       — single-use jti of adapter and logout tokens.
  //   sso_audit        — every applied SSO change (actor `ain-sso` for the adapter).
  handle.exec(`
    CREATE TABLE IF NOT EXISTS sso_identities (
      issuer TEXT NOT NULL,
      subject TEXT NOT NULL,
      user_id TEXT NOT NULL,
      link_method TEXT NOT NULL,
      link_proof TEXT,
      linked_at INTEGER NOT NULL,
      last_login_at INTEGER,
      PRIMARY KEY (issuer, subject),
      UNIQUE (issuer, user_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sso_identities_user ON sso_identities(user_id);
    CREATE TABLE IF NOT EXISTS sso_memberships (
      issuer TEXT NOT NULL,
      org_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      user_id TEXT NOT NULL,
      org_slug TEXT,
      org_name TEXT,
      status TEXT NOT NULL,
      app_role TEXT,
      groups_json TEXT NOT NULL DEFAULT '[]',
      applied_version INTEGER NOT NULL,
      legacy_user_id TEXT,
      ownership_transfer_to TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (issuer, org_id, subject)
    );
    CREATE INDEX IF NOT EXISTS idx_sso_memberships_user ON sso_memberships(user_id);
    CREATE TABLE IF NOT EXISTS sso_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      issuer TEXT NOT NULL,
      subject TEXT NOT NULL,
      oidc_sid TEXT,
      org_id TEXT,
      org_ids TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      ended_at INTEGER,
      end_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sso_sessions_sid ON sso_sessions(issuer, oidc_sid);
    CREATE INDEX IF NOT EXISTS idx_sso_sessions_user ON sso_sessions(user_id);
    CREATE TABLE IF NOT EXISTS sso_login_requests (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      nonce TEXT NOT NULL,
      code_verifier TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      next_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sso_pending_links (
      id TEXT PRIMARY KEY,
      issuer TEXT NOT NULL,
      subject TEXT NOT NULL,
      name TEXT,
      email TEXT,
      email_verified INTEGER NOT NULL DEFAULT 0,
      oidc_sid TEXT,
      org_id TEXT,
      org_ids TEXT NOT NULL DEFAULT '[]',
      next_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sso_replay (
      key TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sso_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      issuer TEXT,
      subject TEXT,
      org_id TEXT,
      user_id TEXT,
      details TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sso_audit_subject ON sso_audit(subject, at);
  `);
  for (const stmt of [
    // Per-account session epoch: session JWTs carry `ep`; one older than this is
    // dead. Bumped only by SSO suspension / back-channel logout (0 = never).
    "ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0",
    // The AIN organization a credential was created for (from the SSO session's
    // org context); NULL = personal. Suspension/offboarding revokes that org's.
    "ALTER TABLE mcp_tokens ADD COLUMN sso_org_id TEXT",
    "ALTER TABLE account_tokens ADD COLUMN sso_org_id TEXT",
    "ALTER TABLE oauth_codes ADD COLUMN sso_org_id TEXT",
    "ALTER TABLE account_oauth_codes ADD COLUMN sso_org_id TEXT",
    // The OIDC prompt of a pending sign-in: 'none' = silent check (the callback
    // turns login_required & co. into an anonymous visit), 'create' = sign-up.
    "ALTER TABLE sso_login_requests ADD COLUMN prompt TEXT",
  ]) {
    try { handle.exec(stmt); } catch (e) {
      if (!/duplicate column/i.test(e.message)) throw e;
    }
  }
  // Organizations (lib/orgs.js, docs/PERMISSIONS.md "Organizations"): a drive
  // shared with an AIN SSO organization (issuer + org_id, as sso_memberships
  // knows it). Every ACTIVE member gets `role` on the whole drive, resolved on
  // each access check from sso_memberships — never copied into drive_members —
  // so a suspension or offboarding ends it at once. Additive and idempotent.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS drive_org_shares (
      drive_id TEXT NOT NULL,
      issuer TEXT NOT NULL,
      org_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (drive_id, issuer, org_id),
      FOREIGN KEY(drive_id) REFERENCES drives(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_drive_org_shares_org ON drive_org_shares(issuer, org_id);
    CREATE INDEX IF NOT EXISTS idx_sso_memberships_org_user ON sso_memberships(issuer, org_id, user_id);
  `);
  // Change feed (lib/share-events-core.js, ain-integration plan task 10): one
  // row per (event, recipient). `seq` is the global cursor (AUTOINCREMENT so a
  // seq is never reused after a prune); `resource_key` is the contract's
  // resource id (`<origin>#<driveId>#<fileId>`); `version` is strictly
  // increasing per resource_key across every recipient (share_event_versions).
  // No FK on drive_id on purpose: a drive's `file.deleted` must outlive the
  // drive row. share_event_floors remembers, per recipient, the highest seq
  // the retention prune removed, so a cursor below it answers `gap: true`.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS share_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient_user_id TEXT NOT NULL,
      resource_key TEXT NOT NULL,
      drive_id TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,
      version INTEGER NOT NULL,
      revision TEXT,
      occurred_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_share_events_recipient ON share_events(recipient_user_id, seq);
    CREATE TABLE IF NOT EXISTS share_event_versions (
      resource_key TEXT PRIMARY KEY,
      version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS share_event_floors (
      recipient_user_id TEXT PRIMARY KEY,
      pruned_to INTEGER NOT NULL
    );
  `);
  // Per-path generations (lib/path-generations.js, ain-integration plan task
  // 10.2): a nonce per (drive, path) handed out with a ref and dropped when the
  // path is re-created or removed, so an old ref never resolves to a newer file
  // at the same path. No FK: rows are dropped with the path, and a drive's rows
  // are meaningless (never read) once the drive is gone.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS path_generations (
      drive_id TEXT NOT NULL,
      path TEXT NOT NULL,
      generation TEXT NOT NULL,
      birth_ms REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (drive_id, path)
    );
  `);
  // ainize Projects bound to a repo folder (lib/git-project-hooks.ts): the
  // project id and its sealed webhook secret, written by POST git-connect,
  // read after a successful push to sign the project's hook call.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS git_project_hooks (
      drive_id TEXT NOT NULL,
      repo TEXT NOT NULL,
      project_id TEXT NOT NULL,
      secret_enc TEXT NOT NULL,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (drive_id, repo),
      FOREIGN KEY(drive_id) REFERENCES drives(id) ON DELETE CASCADE
    );
  `);
  handle.exec(`
    CREATE TABLE IF NOT EXISTS git_project_deliveries (
      id TEXT PRIMARY KEY, drive_id TEXT NOT NULL, repo TEXT NOT NULL,
      payload TEXT NOT NULL, user_id TEXT, origin TEXT,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL, lease TEXT, lease_until INTEGER,
      last_error TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER,
      FOREIGN KEY(drive_id) REFERENCES drives(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS git_project_deliveries_due ON git_project_deliveries(status, next_attempt_at);
  `);
  // Backfill: a drive's old single payout_wallet becomes its root ("") path
  // wallet in the new per-path table. Idempotent — INSERT OR IGNORE on the
  // UNIQUE(drive_id, path) so it only seeds drives that don't already have a
  // root row, and only for drives that had a wallet set.
  handle.exec(`
    INSERT OR IGNORE INTO drive_payout_wallets (id, drive_id, path, wallet)
    SELECT lower(hex(randomblob(6))), id, '', payout_wallet
    FROM drives
    WHERE payout_wallet IS NOT NULL AND payout_wallet != '';
  `);
  return handle;
}

export const db = globalThis.__aindrive_db ?? open();
if (!globalThis.__aindrive_db) globalThis.__aindrive_db = db;

export const drizzleDb = globalThis.__aindrive_drizzle_db ?? drizzle(db, { schema });
if (!globalThis.__aindrive_drizzle_db) globalThis.__aindrive_drizzle_db = drizzleDb;

if (!globalThis.__aindrive_maintenance_started) {
  globalThis.__aindrive_maintenance_started = true;
  import("./sqlite-maintenance.js").then(({ startSqliteMaintenance }) => startSqliteMaintenance()).catch(() => {});
}
