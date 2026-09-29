/**
 * AIN SSO persistence: identity links, the per-account gate, SSO sessions,
 * sign-in state, jti replay, audit, and the provisioning adapter's apply.
 * Plain ESM + store.d.ts (the lib/README.md ".js + .d.ts" pattern) because
 * lib/dochub.js — loaded by `node server.js` without a build — checks the
 * gate too. Tables are created in lib/db.js. Times are epoch ms.
 *
 * Invariants (docs: lib/sso/README.md, AIN SSO adapter-protocol §4):
 *  - An aindrive account is reached from AIN SSO by (issuer, subject) only.
 *    Nothing here selects, creates-or-matches or merges accounts by email.
 *  - An account with SSO membership rows and none `active` is BLOCKED: no
 *    session verifies and no sign-in path may mint one, whatever
 *    AINDRIVE_LEGACY_LOGIN / AINDRIVE_SSO_ENABLED say.
 *  - Users rows are never deleted; personal drives are never transferred.
 */
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { db } from "../db.js";
import { mergeRoleUpgradeOnly } from "../access-core.js";
import { claimInvitesForEmail } from "../invites.js";

export const SSO_PLACEHOLDER_DOMAIN = "sso.aindrive.local";
const RESERVED_EMAIL_DOMAINS = ["wallet.aindrive.local", SSO_PLACEHOLDER_DOMAIN];

const now = () => Date.now();
const json = (v) => JSON.stringify(v ?? null);

/** Addresses no human signup / email attach may claim (wallet + SSO placeholders). */
export function isReservedEmail(email) {
  const e = String(email ?? "").toLowerCase();
  return RESERVED_EMAIL_DOMAINS.some((d) => e.endsWith(`@${d}`));
}

// ── Audit ─────────────────────────────────────────────────────────────────

export function audit({ actor, action, issuer = null, subject = null, orgId = null, userId = null, details = null }) {
  db.prepare(
    "INSERT INTO sso_audit (at, actor, action, issuer, subject, org_id, user_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(now(), actor, action, issuer, subject, orgId, userId, details === null ? null : json(details));
}

// ── Account gate ──────────────────────────────────────────────────────────

/** "unmanaged" (no SSO membership), "active" (active in ≥1 org) or "blocked". */
export function ssoAccountState(userId) {
  const rows = db.prepare("SELECT status FROM sso_memberships WHERE user_id = ?").all(userId);
  if (rows.length === 0) return "unmanaged";
  return rows.some((r) => r.status === "active") ? "active" : "blocked";
}

export function isAccountBlocked(userId) {
  return ssoAccountState(userId) === "blocked";
}

/** Linked to an AIN account (any issuer). */
export function isSsoLinked(userId) {
  return !!db.prepare("SELECT 1 FROM sso_identities WHERE user_id = ? LIMIT 1").get(userId);
}

export function identityFor(issuer, subject) {
  return db
    .prepare("SELECT user_id, link_method, linked_at, last_login_at FROM sso_identities WHERE issuer = ? AND subject = ?")
    .get(issuer, subject);
}

/**
 * An account the provisioning adapter created before anyone signed in through
 * it (no SSO session was ever made for it: last_login_at is set by
 * createSsoSession). Nobody used it, so a verified legacy link — the adapter's
 * legacyUserId or an in-app proof — replaces it. What others gave it (a drive
 * shared with the address it holds) moves along (replacePlaceholder).
 */
export function isPlaceholderIdentity(ident) {
  return !!ident && ident.link_method === "provisioned" && (ident.last_login_at === null || ident.last_login_at === undefined);
}

/**
 * Drive grants of `fromUserId` become `toUserId`'s, upgrade-only per (drive,
 * path) like every grant (never lowers a role the account already has; none
 * on a drive it owns). Returns how many grants moved.
 */
function moveDriveGrants(fromUserId, toUserId) {
  const rows = db
    .prepare("SELECT m.drive_id, m.path, m.role, d.owner_id FROM drive_members m JOIN drives d ON d.id = m.drive_id WHERE m.user_id = ?")
    .all(fromUserId);
  const current = db.prepare("SELECT role FROM drive_members WHERE drive_id = ? AND user_id = ? AND path = ?");
  const upsert = db.prepare(
    "INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?, ?, ?, ?, ?) ON CONFLICT(drive_id, user_id, path) DO UPDATE SET role = excluded.role",
  );
  for (const r of rows) {
    if (r.owner_id === toUserId) continue;
    upsert.run(nanoid(12), r.drive_id, toUserId, r.path, mergeRoleUpgradeOnly(current.get(r.drive_id, toUserId, r.path)?.role ?? "none", r.role));
  }
  db.prepare("DELETE FROM drive_members WHERE user_id = ?").run(fromUserId);
  return rows.length;
}

/**
 * Re-points a placeholder link to the verified legacy account; the
 * organization state recorded for the subject moves with it, and so do the
 * drive grants people gave the placeholder (it took the person's free work
 * address, and the members route grants by address). The placeholder then
 * gives that address up for a reserved one, so later shares to it don't land
 * on an account nobody signs in to (and no email reset can reach it). The
 * placeholder users row stays (users are never deleted).
 */
function replacePlaceholder({ issuer, subject, placeholderUserId, userId, method, proof, actor, orgId = null }) {
  db.prepare(
    `UPDATE sso_identities SET user_id = ?, link_method = ?, link_proof = ?, linked_at = ?, last_login_at = NULL
     WHERE issuer = ? AND subject = ? AND user_id = ?`,
  ).run(userId, method, proof === undefined ? null : json(proof), now(), issuer, subject, placeholderUserId);
  db.prepare("UPDATE sso_memberships SET user_id = ? WHERE issuer = ? AND subject = ? AND user_id = ?").run(userId, issuer, subject, placeholderUserId);
  const grantsMoved = moveDriveGrants(placeholderUserId, userId);
  const held = db.prepare("SELECT email FROM users WHERE id = ?").get(placeholderUserId);
  const emailReleased = !!held && !isReservedEmail(held.email);
  if (emailReleased) db.prepare("UPDATE users SET email = ? WHERE id = ?").run(emailForNewAccount([], subject), placeholderUserId);
  audit({ actor, action: "placeholder_replaced", issuer, subject, orgId, userId, details: { placeholderUserId, method, grantsMoved, emailReleased } });
}

export function sessionEpoch(userId) {
  const row = db.prepare("SELECT session_epoch FROM users WHERE id = ?").get(userId);
  return row ? row.session_epoch : 0;
}

/**
 * The account a verified session-JWT payload still reaches, or null. Legacy
 * tokens ({sub} only, no `ep`) keep working exactly as before until the
 * account's epoch is bumped (suspension / back-channel logout). An SSO
 * session token also carries `ses`, which must name a live sso_sessions row.
 */
export function liveSessionUserId(payload) {
  const sub = payload && typeof payload.sub === "string" && payload.sub ? payload.sub : null;
  if (!sub) return null;
  if (payload.ses !== undefined) {
    if (typeof payload.ses !== "string") return null;
    const s = db.prepare("SELECT user_id, ended_at, expires_at FROM sso_sessions WHERE id = ?").get(payload.ses);
    if (!s || s.user_id !== sub || s.ended_at !== null || s.expires_at <= now()) return null;
  }
  const user = db.prepare("SELECT session_epoch FROM users WHERE id = ?").get(sub);
  // No row: unchanged behaviour — callers already resolve an unknown id to no one.
  if (!user) return sub;
  const ep = typeof payload.ep === "number" && Number.isInteger(payload.ep) ? payload.ep : 0;
  if (ep < user.session_epoch) return null;
  if (isAccountBlocked(sub)) return null;
  return sub;
}

// ── Sessions ──────────────────────────────────────────────────────────────

const SSO_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // same as the session cookie

export function createSsoSession({ userId, issuer, subject, oidcSid, orgId, orgIds }) {
  if (isAccountBlocked(userId)) throw new Error("account_blocked");
  const id = randomBytes(18).toString("base64url");
  const t = now();
  // Housekeeping: rows past expiry by a week can no longer verify anything.
  db.prepare("DELETE FROM sso_sessions WHERE expires_at < ?").run(t - 7 * 24 * 60 * 60 * 1000);
  db.prepare(
    `INSERT INTO sso_sessions (id, user_id, issuer, subject, oidc_sid, org_id, org_ids, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, issuer, subject, oidcSid ?? null, orgId ?? null, json(orgIds ?? []), t, t + SSO_SESSION_TTL_MS);
  db.prepare("UPDATE sso_identities SET last_login_at = ? WHERE issuer = ? AND subject = ?").run(t, issuer, subject);
  return id;
}

export function getSsoSession(id) {
  return db.prepare("SELECT * FROM sso_sessions WHERE id = ?").get(id) ?? null;
}

export function endSsoSession(id, reason) {
  return db
    .prepare("UPDATE sso_sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL")
    .run(now(), reason, id).changes;
}

/** Back-channel logout by OIDC sid: ends only the sessions created with that sid. */
export function endSessionsBySid(issuer, oidcSid, reason = "backchannel_logout") {
  const rows = db
    .prepare("SELECT id, user_id FROM sso_sessions WHERE issuer = ? AND oidc_sid = ? AND ended_at IS NULL")
    .all(issuer, oidcSid);
  const end = db.prepare("UPDATE sso_sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL");
  const t = now();
  for (const r of rows) end.run(t, reason, r.id);
  return rows;
}

/**
 * Ends every session of the account: bumps the epoch (every session JWT —
 * browser cookie, CLI/mobile pairing token, bearer — dies), ends SSO session
 * rows and drops approved-but-uncollected CLI pairings. Open collaboration
 * sockets are closed by the caller after commit (disconnectUserSockets).
 */
export function endAllUserSessions(userId, reason) {
  // A transaction (a savepoint when called inside applyDesiredState's).
  return db.transaction(() => {
    const t = now();
    db.prepare("UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ?").run(userId);
    const ended = db
      .prepare("UPDATE sso_sessions SET ended_at = ?, end_reason = ? WHERE user_id = ? AND ended_at IS NULL")
      .run(t, reason, userId).changes;
    db.prepare("DELETE FROM cli_link_requests WHERE user_id = ? AND consumed_at IS NULL").run(userId);
    return ended;
  })();
}

/**
 * A legacy mapping was rolled back (adapter-protocol §4.4: "end the sessions
 * and credentials the person obtained on it through the link, before
 * answering"). aindrive cannot tell the account's owner from the person
 * wrongly linked to it, so everything that may have come through the link
 * ends: every session JWT (epoch bump — browser cookie, CLI/mobile pairing
 * token, bearer), the SSO session rows and uncollected CLI pairings; PATs,
 * OAuth grants and unredeemed codes made in an SSO session or since the link
 * was made; wallet sign-in added since then. Open collaboration sockets are
 * closed by the caller after commit. Drives, files and grants stay.
 */
function endLinkedAccess(userId, linkedAt, reason) {
  const t = now();
  const since = Number.isFinite(linkedAt) ? linkedAt : 0;
  const ssoSessionRows = endAllUserSessions(userId, reason);
  const cred = "user_id = ? AND (sso_org_id IS NOT NULL OR created_at >= ?)";
  return {
    ssoSessionRows,
    mcpTokens: db.prepare(`UPDATE mcp_tokens SET revoked_at = ? WHERE revoked_at IS NULL AND ${cred}`).run(t, userId, since).changes,
    accountTokens: db.prepare(`UPDATE account_tokens SET revoked_at = ? WHERE revoked_at IS NULL AND ${cred}`).run(t, userId, since).changes,
    codes:
      db.prepare(`UPDATE oauth_codes SET consumed = 1 WHERE consumed = 0 AND ${cred}`).run(userId, since).changes +
      db.prepare(`UPDATE account_oauth_codes SET consumed = 1 WHERE consumed = 0 AND ${cred}`).run(userId, since).changes,
    walletLogins: db
      .prepare("UPDATE account_wallets SET login_enabled = 0 WHERE account_id = ? AND login_enabled = 1 AND linked_at >= datetime(?, 'unixepoch')")
      .run(userId, Math.floor(since / 1000)).changes,
  };
}

/** Closes the account's live collaboration websockets (hook registered by lib/dochub.js). */
export function disconnectUserSockets(match) {
  const hook = globalThis.__aindrive_dochub_disconnect;
  return typeof hook === "function" ? hook(match) : 0;
}

// ── Sign-in state (short-lived) ───────────────────────────────────────────

const LOGIN_REQUEST_TTL_MS = 10 * 60 * 1000;
const PENDING_LINK_TTL_MS = 15 * 60 * 1000;

function sweepSignInState(t) {
  db.prepare("DELETE FROM sso_login_requests WHERE expires_at < ?").run(t);
  db.prepare("DELETE FROM sso_pending_links WHERE expires_at < ?").run(t);
}

export function createLoginRequest({ state, nonce, codeVerifier, redirectUri, nextPath, prompt = null }) {
  const t = now();
  sweepSignInState(t);
  const id = randomBytes(24).toString("base64url");
  db.prepare(
    `INSERT INTO sso_login_requests (id, state, nonce, code_verifier, redirect_uri, next_path, prompt, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, state, nonce, codeVerifier, redirectUri, nextPath, prompt ?? null, t, t + LOGIN_REQUEST_TTL_MS);
  return id;
}

/** One-time: the row is deleted whether or not it is still valid. */
export function takeLoginRequest(id) {
  if (!id) return null;
  const row = db.prepare("SELECT * FROM sso_login_requests WHERE id = ?").get(id);
  if (!row) return null;
  db.prepare("DELETE FROM sso_login_requests WHERE id = ?").run(id);
  return row.expires_at > now() ? row : null;
}

export function createPendingLink({ issuer, subject, name, email, emailVerified, oidcSid, orgId, orgIds, nextPath }) {
  const t = now();
  sweepSignInState(t);
  const id = randomBytes(24).toString("base64url");
  db.prepare(
    `INSERT INTO sso_pending_links (id, issuer, subject, name, email, email_verified, oidc_sid, org_id, org_ids, next_path, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, issuer, subject, name ?? null, email ?? null, emailVerified ? 1 : 0, oidcSid ?? null, orgId ?? null, json(orgIds ?? []), nextPath, t, t + PENDING_LINK_TTL_MS);
  return id;
}

export function getPendingLink(id) {
  if (!id) return null;
  const row = db.prepare("SELECT * FROM sso_pending_links WHERE id = ?").get(id);
  return row && row.expires_at > now() ? row : null;
}

export function deletePendingLink(id) {
  db.prepare("DELETE FROM sso_pending_links WHERE id = ?").run(id);
}

/**
 * Back-channel logout: an AIN sign-in still waiting on /sso/link ("connect or
 * create") from that OIDC session — or, with only `sub`, from any session of
 * that AIN account — can no longer be finished. Returns how many were dropped.
 */
export function cancelPendingLinks(issuer, { sid = null, sub = null } = {}) {
  if (sid) return db.prepare("DELETE FROM sso_pending_links WHERE issuer = ? AND oidc_sid = ?").run(issuer, sid).changes;
  if (sub) return db.prepare("DELETE FROM sso_pending_links WHERE issuer = ? AND subject = ?").run(issuer, sub).changes;
  return 0;
}

// ── Identity linking ──────────────────────────────────────────────────────

function emailTaken(email) {
  return !!db.prepare("SELECT 1 FROM users WHERE lower(email) = lower(?)").get(email);
}

/**
 * users.email is UNIQUE NOT NULL. A new SSO account uses the first free,
 * plausible candidate as CONTACT data; if every candidate is taken (typically
 * by the same person's unlinked legacy account) it gets a placeholder — it
 * is never attached to the account that holds the address.
 */
function emailForNewAccount(candidates, subject) {
  for (const c of candidates) {
    const e = typeof c === "string" ? c.trim().toLowerCase() : "";
    if (e && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !isReservedEmail(e) && !emailTaken(e)) return e;
  }
  const local = String(subject).toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 48) || "user";
  const base = `${local}@${SSO_PLACEHOLDER_DOMAIN}`;
  return emailTaken(base) ? `${local}.${nanoid(8).toLowerCase()}@${SSO_PLACEHOLDER_DOMAIN}` : base;
}

function nameForNewAccount(name, email) {
  const n = typeof name === "string" ? name.trim().slice(0, 80) : "";
  if (n) return n;
  if (email && !isReservedEmail(email)) return email.split("@")[0].slice(0, 80);
  return "AIN user";
}

function insertIdentity({ issuer, subject, userId, method, proof }) {
  db.prepare(
    "INSERT INTO sso_identities (issuer, subject, user_id, link_method, link_proof, linked_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(issuer, subject, userId, method, proof === undefined ? null : json(proof), now());
}

function insertNewUser({ name, emailCandidates, subject, passwordHash }) {
  const id = nanoid(10);
  const email = emailForNewAccount(emailCandidates, subject);
  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)")
    .run(id, email, nameForNewAccount(name, email), passwordHash);
  return { id, email };
}

/** An unusable password: random input no login attempt can reproduce. */
function unusablePasswordHash() {
  return bcrypt.hashSync(nanoid(24), 10);
}

/**
 * The account for (issuer, subject), creating it just in time if none is
 * linked. Atomic under concurrent first logins (several requests or several
 * processes): one immediate transaction + the (issuer, subject) primary key,
 * so exactly one account is created and every caller gets it. An account that
 * takes the AIN-verified address claims the drive invites pending for it,
 * as a legacy sign-up does after its emailed code.
 */
export function resolveOrCreateUserForSubject({ issuer, subject, name, email, emailVerified, method = "jit", actor = "ain-sso-login" }) {
  const passwordHash = unusablePasswordHash(); // outside the write lock (bcrypt is slow)
  const run = db.transaction(() => {
    const hit = identityFor(issuer, subject);
    if (hit) return { userId: hit.user_id, created: false };
    const user = insertNewUser({ name, emailCandidates: emailVerified ? [email] : [], subject, passwordHash });
    insertIdentity({ issuer, subject, userId: user.id, method, proof: { emailVerified: !!emailVerified } });
    const invitesClaimed = emailVerified && !isReservedEmail(user.email) ? claimInvitesForEmail(user.id, user.email) : 0;
    audit({ actor, action: "user_created", issuer, subject, userId: user.id, details: { method, invitesClaimed } });
    return { userId: user.id, created: true };
  });
  return run.immediate();
}

/**
 * Links an existing (legacy) account to (issuer, subject) after the caller
 * verified a proof of that account (existing session, password, or an
 * adapter-supplied legacy mapping). Never re-points an existing link.
 */
export function linkExistingUser({ issuer, subject, userId, method, proof, actor }) {
  const run = db.transaction(() => {
    const hit = identityFor(issuer, subject);
    if (hit && hit.user_id === userId) return { ok: true, userId };
    if (hit && !isPlaceholderIdentity(hit)) return { ok: false, error: "sub_already_linked" };
    if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId)) return { ok: false, error: "user_not_found" };
    const other = db.prepare("SELECT subject FROM sso_identities WHERE issuer = ? AND user_id = ?").get(issuer, userId);
    if (other) return { ok: false, error: "account_already_linked" };
    if (isAccountBlocked(userId)) return { ok: false, error: "account_suspended" };
    if (hit) replacePlaceholder({ issuer, subject, placeholderUserId: hit.user_id, userId, method, proof, actor });
    else insertIdentity({ issuer, subject, userId, method, proof });
    audit({ actor, action: "legacy_linked", issuer, subject, userId, details: { method } });
    return { ok: true, userId };
  });
  return run.immediate();
}

// ── Replay cache (adapter + logout tokens) ────────────────────────────────

let replaySweepCounter = 0;

/** Records `key` until `expiresAtMs`; false when it was already seen (and not expired). */
export function checkAndStoreJti(key, expiresAtMs) {
  const t = now();
  if (++replaySweepCounter % 200 === 0) db.prepare("DELETE FROM sso_replay WHERE expires_at <= ?").run(t);
  const res = db
    .prepare(
      `INSERT INTO sso_replay (key, expires_at) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at WHERE sso_replay.expires_at <= ?`,
    )
    .run(key, expiresAtMs, t);
  return res.changes === 1;
}

// ── Provisioning adapter ──────────────────────────────────────────────────

export class AdapterError extends Error {
  constructor(code, status = 400, message, retryable = status >= 500 || status === 429) {
    super(message ?? code);
    this.name = "AdapterError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function getAppliedState(issuer, orgId, subject) {
  const row = db
    .prepare("SELECT user_id, applied_version, status, app_role, groups_json FROM sso_memberships WHERE issuer = ? AND org_id = ? AND subject = ?")
    .get(issuer, orgId, subject);
  if (!row) return null;
  let groups = [];
  try { groups = JSON.parse(row.groups_json); } catch {}
  return { exists: true, localUserId: row.user_id, appliedVersion: row.applied_version, status: row.status, appRole: row.app_role, groups };
}

/**
 * Organization-scoped credentials of the account for `orgId`: PATs and OAuth
 * grants created from an SSO session in that organization (sso_org_id). Both
 * tokens of a grant live in one row, so revoking the row kills the refresh
 * token too; unredeemed codes are burned so none can still turn into a token.
 * Personal credentials (sso_org_id NULL) are not touched.
 */
function revokeOrgCredentials(userId, orgId) {
  const t = now();
  return {
    mcpTokens: db.prepare("UPDATE mcp_tokens SET revoked_at = ? WHERE user_id = ? AND sso_org_id = ? AND revoked_at IS NULL").run(t, userId, orgId).changes,
    accountTokens: db.prepare("UPDATE account_tokens SET revoked_at = ? WHERE user_id = ? AND sso_org_id = ? AND revoked_at IS NULL").run(t, userId, orgId).changes,
    codes:
      db.prepare("UPDATE oauth_codes SET consumed = 1 WHERE user_id = ? AND sso_org_id = ? AND consumed = 0").run(userId, orgId).changes +
      db.prepare("UPDATE account_oauth_codes SET consumed = 1 WHERE user_id = ? AND sso_org_id = ? AND consumed = 0").run(userId, orgId).changes,
  };
}

/**
 * adapter-protocol §4.4: link by sub; a verified legacyUserId once; follow a
 * rolled-back mapping. Accounts whose sessions ended are added to `ended`;
 * an account a rolled-back mapping pointed at is added to `unlinked` whether
 * or not anyone signed in through the link — its organization access came
 * over its own sessions too (lib/orgs.js). The caller closes both accounts'
 * sockets after commit.
 */
function resolveUserForState(issuer, s, passwordHash, ended, unlinked) {
  const ev = (action, userId, details) => audit({ actor: "ain-sso", action, issuer, subject: s.sub, orgId: s.org.id, userId, details: { version: s.version, ...details } });
  let ident = identityFor(issuer, s.sub);

  if (ident && ident.link_method === "legacy_mapping" && s.legacyUserId !== ident.user_id) {
    // The mapping was rolled back at AIN SSO: this legacy account is no longer
    // this person's. If anyone signed in through the link (last_login_at),
    // everything they could have obtained on it ends before the 200
    // (endLinkedAccess); its data stays.
    db.prepare("DELETE FROM sso_identities WHERE issuer = ? AND subject = ?").run(issuer, s.sub);
    const used = ident.last_login_at !== null && ident.last_login_at !== undefined;
    const revoked = used ? endLinkedAccess(ident.user_id, ident.linked_at, "legacy_mapping_rolled_back") : {};
    if (used) ended.push(ident.user_id);
    unlinked.push(ident.user_id);
    ev("legacy_unlinked", ident.user_id, { legacyUserId: ident.user_id, used, ...revoked });
    ident = undefined;
  }
  // A placeholder made by an earlier push (nobody signed in to it yet) gives
  // way to the legacy account once AIN SSO knows it (e.g. an app attestation
  // linked after the account was provisioned).
  const replacing = ident && s.legacyUserId && s.legacyUserId !== ident.user_id && isPlaceholderIdentity(ident);
  if (ident && !replacing) return ident.user_id;

  if (s.legacyUserId) {
    const legacy = db.prepare("SELECT id FROM users WHERE id = ?").get(s.legacyUserId);
    if (!legacy) throw new AdapterError("legacy_user_not_found", 409, "The legacy user in legacyUserId does not exist.", false);
    const other = db.prepare("SELECT subject FROM sso_identities WHERE issuer = ? AND user_id = ?").get(issuer, legacy.id);
    if (other && other.subject !== s.sub) throw new AdapterError("legacy_conflict", 409, "The legacy user is linked to another account.", false);
    const proof = { orgId: s.org.id, version: s.version };
    if (replacing) replacePlaceholder({ issuer, subject: s.sub, placeholderUserId: ident.user_id, userId: legacy.id, method: "legacy_mapping", proof, actor: "ain-sso", orgId: s.org.id });
    else insertIdentity({ issuer, subject: s.sub, userId: legacy.id, method: "legacy_mapping", proof });
    ev("legacy_linked", legacy.id, { method: "legacy_mapping" });
    return legacy.id;
  }

  const { id: userId } = insertNewUser({ name: s.profile.name, emailCandidates: [s.profile.workEmail, s.profile.email], subject: s.sub, passwordHash });
  insertIdentity({ issuer, subject: s.sub, userId, method: "provisioned", proof: { orgId: s.org.id, version: s.version } });
  ev("user_created", userId, { method: "provisioned" });
  return userId;
}

/**
 * Applies a verified DesiredUserState (adapter-protocol §4) in ONE immediate
 * transaction: version compare-and-set per (issuer, org, sub) — an older or
 * equal version changes nothing — then link/create the account, record the
 * membership, and for suspended/deprovisioned end every session and revoke
 * the organization's credentials BEFORE the caller answers 200.
 *
 * aindrive has no organization-owned drives (every drive is personal,
 * ownership.md §2), so `deprovisioned` + ownershipTransferTo transfers
 * nothing; personal drives are never moved. What an organization gets is a
 * personal drive its creator shared with it (lib/orgs.js): that access is read
 * from these rows on every check, so a non-active status ends it with this
 * commit. appRole only decides who may share a drive with the organization
 * (`admin`/`owner`, lib/org-policy.js); groups are recorded and reported.
 *
 * A rolled-back legacy mapping ends what the wrongly linked person obtained
 * on that account the same way (endLinkedAccess), also before the 200.
 *
 * After commit the caller closes the sockets of `endedUserIds` and
 * `unlinkedUserIds`, and re-checks open sockets on the drives of every
 * organization in `orgIds`: the pushed one and the subject's others (whose
 * rows move to another account when the subject is re-linked).
 *
 * @returns {{ result: {appliedVersion:number, localUserId:string, status:string}, endedUserIds: string[], unlinkedUserIds: string[], orgIds: string[] }}
 */
export function applyDesiredState(issuer, s) {
  const key = [issuer, s.org.id, s.sub];
  const cur0 = db.prepare("SELECT applied_version FROM sso_memberships WHERE issuer = ? AND org_id = ? AND subject = ?").get(...key);
  // Only when this request could create an account: keep bcrypt out of the write lock.
  const passwordHash = !cur0 || s.version > cur0.applied_version ? unusablePasswordHash() : "";

  const run = db.transaction(() => {
    const cur = db.prepare("SELECT * FROM sso_memberships WHERE issuer = ? AND org_id = ? AND subject = ?").get(...key);
    if (cur && s.version <= cur.applied_version) {
      return { result: { appliedVersion: cur.applied_version, localUserId: cur.user_id, status: cur.status }, endedUserIds: [], unlinkedUserIds: [], orgIds: [] };
    }
    const ended = [];
    const unlinked = [];
    // Every organization of this subject, read before its rows can move to
    // another account (a rolled-back mapping or a placeholder hand-over).
    const subjectOrgIds = db
      .prepare("SELECT DISTINCT org_id FROM sso_memberships WHERE issuer = ? AND subject = ?")
      .all(issuer, s.sub).map((r) => r.org_id);
    const userId = resolveUserForState(issuer, s, passwordHash || unusablePasswordHash(), ended, unlinked);
    const name = typeof s.profile.name === "string" ? s.profile.name.trim().slice(0, 80) : "";
    if (name) db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, userId);
    // A re-linked subject (rolled-back legacy mapping) brings its other orgs along.
    db.prepare("UPDATE sso_memberships SET user_id = ? WHERE issuer = ? AND subject = ? AND user_id != ?").run(userId, issuer, s.sub, userId);

    const active = s.status === "active";
    const groups = active ? s.groups.map((g) => g.slug).sort() : [];
    db.prepare(
      `INSERT INTO sso_memberships (issuer, org_id, subject, user_id, org_slug, org_name, status, app_role, groups_json,
                                    applied_version, legacy_user_id, ownership_transfer_to, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(issuer, org_id, subject) DO UPDATE SET
         user_id = excluded.user_id, org_slug = excluded.org_slug, org_name = excluded.org_name,
         status = excluded.status, app_role = excluded.app_role, groups_json = excluded.groups_json,
         applied_version = excluded.applied_version, legacy_user_id = excluded.legacy_user_id,
         ownership_transfer_to = excluded.ownership_transfer_to, updated_at = excluded.updated_at`,
    ).run(issuer, s.org.id, s.sub, userId, s.org.slug, s.org.name, s.status, active ? s.appRole : null, json(groups),
      s.version, s.legacyUserId, s.ownershipTransferTo, now());

    const ev = (action, details) => audit({ actor: "ain-sso", action, issuer, subject: s.sub, orgId: s.org.id, userId, details: { version: s.version, ...details } });
    if (!active) {
      const entering = !cur || cur.status !== s.status || cur.user_id !== userId;
      const endedSessions = entering ? endAllUserSessions(userId, `sso_${s.status}`) : 0;
      if (entering && !ended.includes(userId)) ended.push(userId);
      const revoked = revokeOrgCredentials(userId, s.org.id);
      if (entering || revoked.mcpTokens + revoked.accountTokens + revoked.codes > 0) {
        ev("access_revoked", { status: s.status, sessionsEnded: entering, ssoSessionRows: endedSessions, ...revoked });
      }
      if (s.status === "deprovisioned" && (!cur || cur.status !== "deprovisioned")) {
        ev("ownership_transfer", { to: s.ownershipTransferTo, transferred: [], reason: "no organization-owned drives in aindrive; personal drives stay with the person" });
      }
    }
    ev("applied", { status: s.status, appRole: active ? s.appRole : null, groups });
    return {
      result: { appliedVersion: s.version, localUserId: userId, status: s.status },
      endedUserIds: ended,
      unlinkedUserIds: unlinked,
      orgIds: [...new Set([s.org.id, ...subjectOrgIds])],
    };
  });
  return run.immediate();
}
