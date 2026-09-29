/**
 * Organizations: drives shared with an AIN SSO organization
 * (docs/PERMISSIONS.md "Organizations"; the pure rules are in org-policy.js).
 *
 * An organization is what the AIN SSO provisioning adapter recorded in
 * sso_memberships: (issuer, org_id) with its slug and name. A drive's creator
 * shares the whole drive with one as viewer or editor (drive_org_shares).
 * Access through it is computed on every check (access.ts, dochub.js,
 * mcp-tokens.ts), never copied into drive_members, and holds only:
 *   - while the provisioning adapter is configured for that issuer
 *     (AINDRIVE_SSO_ISSUER + AINDRIVE_SSO_CLIENT_ID) — memberships nobody
 *     keeps current any more grant nothing;
 *   - for a person whose membership in that org is active: every row for
 *     that (org, account) is `active` — a suspended/deprovisioned row wins;
 *   - while the drive's creator is an active member of that org too: the
 *     share is what they gave the org as a member, so suspending or
 *     offboarding them stops it (adapter-protocol §4.3 "stop org-derived
 *     permissions"); reactivation restores it.
 * The role is a ceiling like any grant: an org viewer is a bare viewer (the
 * paid carve-out applies), and org membership never makes anyone an owner.
 *
 * Plain ESM (+ orgs.d.ts): lib/dochub.js (under `node server.js`) and the
 * operator script scripts/org-drive.mjs use it too.
 */
import { db } from "./db.js";
import { ROLE_RANK } from "./access-core.js";
import { audit } from "./sso/store.js";
import { ORG_SHARE_ROLES, landingPath, orgShareDecision, parseOrgShareAllowlist } from "./org-policy.js";

const now = () => Date.now();

/** The AIN SSO issuer organization access is evaluated for, or null (adapter off → no org access). */
export function orgAccessIssuer() {
  const issuer = (process.env.AINDRIVE_SSO_ISSUER ?? "").trim();
  const clientId = (process.env.AINDRIVE_SSO_CLIENT_ID ?? "").trim();
  return issuer && clientId ? issuer : null;
}

/** The operator's AINDRIVE_ORG_SHARE_ALLOWLIST (read per call: a restart applies a change). */
export function orgShareAllowlist() {
  return parseOrgShareAllowlist(process.env.AINDRIVE_ORG_SHARE_ALLOWLIST).entries;
}

// SQL: `who` (a column or a named parameter) is an active member of the
// organization of the drive_org_shares row aliased `s`.
const activeIn = (who) => `(
  EXISTS (SELECT 1 FROM sso_memberships ma WHERE ma.issuer = s.issuer AND ma.org_id = s.org_id AND ma.user_id = ${who} AND ma.status = 'active')
  AND NOT EXISTS (SELECT 1 FROM sso_memberships mb WHERE mb.issuer = s.issuer AND mb.org_id = s.org_id AND mb.user_id = ${who} AND mb.status != 'active'))`;

function bestOrgRole(rows) {
  let best = "none";
  for (const r of rows) {
    if (ORG_SHARE_ROLES.includes(r.role) && ROLE_RANK[r.role] > ROLE_RANK[best]) best = r.role;
  }
  return best;
}

/**
 * The role `userId` holds on the whole drive through an organization
 * ("none" | "viewer" | "editor"). Merged with drive_members by the callers
 * (highest wins), so it never lowers a personal grant.
 */
let roleStmt = null; // hot path: every access check of a signed-in user
export function orgRoleInDrive(driveId, userId) {
  const issuer = orgAccessIssuer();
  if (!issuer || !driveId || !userId) return "none";
  roleStmt ??= db.prepare(
    `SELECT s.role FROM drive_org_shares s JOIN drives d ON d.id = s.drive_id
     WHERE s.drive_id = @driveId AND s.issuer = @issuer AND ${activeIn("@userId")} AND ${activeIn("d.owner_id")}`,
  );
  return bestOrgRole(roleStmt.all({ driveId, issuer, userId }));
}

/** Drives `userId` reaches through an organization (one row per drive and org), newest first. */
export function orgDrivesForUser(userId) {
  const issuer = orgAccessIssuer();
  if (!issuer || !userId) return [];
  return db.prepare(
    `SELECT d.*, s.org_id AS org_id, s.role AS org_role FROM drive_org_shares s JOIN drives d ON d.id = s.drive_id
     WHERE s.issuer = @issuer AND ${activeIn("@userId")} AND ${activeIn("d.owner_id")}
     ORDER BY d.created_at DESC, d.id`,
  ).all({ issuer, userId });
}

/** The organizations `userId` is an active member of (current issuer), by name. */
export function userOrgs(userId) {
  const issuer = orgAccessIssuer();
  if (!issuer || !userId) return [];
  return db.prepare(
    `SELECT m.issuer, m.org_id, m.subject, m.app_role, m.org_slug, m.org_name FROM sso_memberships m
     WHERE m.user_id = ? AND m.issuer = ? AND m.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM sso_memberships x WHERE x.issuer = m.issuer AND x.org_id = m.org_id AND x.user_id = m.user_id AND x.status != 'active')
     ORDER BY COALESCE(m.org_name, m.org_slug, m.org_id) COLLATE NOCASE, m.org_id`,
  ).all(userId, issuer).map((r) => ({
    issuer: r.issuer,
    orgId: r.org_id,
    subject: r.subject,
    appRole: r.app_role,
    slug: r.org_slug || null,
    name: r.org_name || r.org_slug || r.org_id,
  }));
}

/**
 * The signed-in home: each organization the person is an active member of,
 * with the drives shared with it (an empty list = the org has none yet).
 */
export function listOrgDrivesForUser(userId) {
  const orgs = userOrgs(userId);
  if (orgs.length === 0) return [];
  const drives = orgDrivesForUser(userId);
  return orgs.map((o) => ({ ...o, drives: drives.filter((d) => d.org_id === o.orgId) }));
}

/** Owns a drive that is not shared with an organization (the landing rule's "personal drive"). */
export function ownsPersonalDrive(userId) {
  return !!db.prepare(
    "SELECT 1 FROM drives d WHERE d.owner_id = ? AND NOT EXISTS (SELECT 1 FROM drive_org_shares s WHERE s.drive_id = d.id) LIMIT 1",
  ).get(userId);
}

/** Where a sign-in lands (org-policy.js landingPath, fed from the DB). */
export function signInLandingPath(userId, nextPath, firstSignIn) {
  const orgDriveIds = orgDrivesForUser(userId).map((d) => d.id);
  return landingPath({ nextPath, firstSignIn, ownsPersonalDrive: ownsPersonalDrive(userId), orgDriveIds });
}

/** Latest slug/name AIN SSO pushed for an organization. */
export function orgInfo(issuer, orgId) {
  const r = db.prepare(
    "SELECT org_slug, org_name FROM sso_memberships WHERE issuer = ? AND org_id = ? ORDER BY updated_at DESC LIMIT 1",
  ).get(issuer, orgId);
  return { slug: r?.org_slug || null, name: r?.org_name || r?.org_slug || orgId };
}

/**
 * The organizations a drive is shared with, for its Manage page and the
 * operator script. `inForce` = members get access now (current issuer, and
 * the drive's creator is still an active member of that org).
 */
export function listDriveOrgShares(driveId) {
  const issuer = orgAccessIssuer();
  const rows = db.prepare(
    `SELECT s.issuer, s.org_id, s.role, s.created_by, s.created_at, s.updated_at,
            CASE WHEN ${activeIn("d.owner_id")} THEN 1 ELSE 0 END AS owner_active,
            (SELECT COUNT(DISTINCT ma.user_id) FROM sso_memberships ma
              WHERE ma.issuer = s.issuer AND ma.org_id = s.org_id AND ma.status = 'active'
                AND NOT EXISTS (SELECT 1 FROM sso_memberships mb WHERE mb.issuer = ma.issuer AND mb.org_id = ma.org_id AND mb.user_id = ma.user_id AND mb.status != 'active')
            ) AS active_members
     FROM drive_org_shares s JOIN drives d ON d.id = s.drive_id
     WHERE s.drive_id = ? ORDER BY s.created_at, s.org_id`,
  ).all(driveId);
  return rows.map((r) => {
    const info = orgInfo(r.issuer, r.org_id);
    return {
      issuer: r.issuer,
      orgId: r.org_id,
      slug: info.slug,
      name: info.name,
      role: r.role,
      activeMembers: r.active_members,
      ownerActive: r.owner_active === 1,
      inForce: r.issuer === issuer && r.owner_active === 1,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
}

/** `userId`'s membership in (issuer, orgId) as org-policy.js orgShareDecision reads it, or null. */
export function membershipFor(userId, issuer, orgId) {
  const rows = db.prepare(
    "SELECT subject, status, app_role, org_slug FROM sso_memberships WHERE issuer = ? AND org_id = ? AND user_id = ? ORDER BY updated_at DESC",
  ).all(issuer, orgId, userId);
  if (rows.length === 0) return null;
  const active = rows.every((r) => r.status === "active");
  return { orgId, slug: rows[0].org_slug || null, subject: rows[0].subject, appRole: active ? rows[0].app_role : null, active };
}

/**
 * May `userId` share `driveId` with `orgId` from the app (the Manage page)?
 * Returns the decision plus the issuer and membership the share is made for.
 */
export function checkOrgShare(driveId, userId, orgId) {
  const issuer = orgAccessIssuer();
  if (!issuer) return { ok: false, status: 404, error: "organization sharing needs AIN SSO" };
  const drive = db.prepare("SELECT owner_id FROM drives WHERE id = ?").get(driveId);
  if (!drive) return { ok: false, status: 404, error: "drive not found" };
  const membership = membershipFor(userId, issuer, orgId);
  const decision = orgShareDecision({ isCreator: drive.owner_id === userId, userId, membership, allowlist: orgShareAllowlist() });
  return decision.ok ? { ...decision, issuer, membership } : decision;
}

/** The creator's organizations for the Manage page, each with whether they may share this drive with it. */
export function orgShareCandidates(driveId, userId) {
  const drive = db.prepare("SELECT owner_id FROM drives WHERE id = ?").get(driveId);
  if (!drive) return [];
  const allowlist = orgShareAllowlist();
  return userOrgs(userId).map((o) => {
    const d = orgShareDecision({
      isCreator: drive.owner_id === userId,
      userId,
      membership: { orgId: o.orgId, slug: o.slug, subject: o.subject, appRole: o.appRole, active: true },
      allowlist,
    });
    return { orgId: o.orgId, slug: o.slug, name: o.name, canShare: d.ok, reason: d.ok ? null : d.error };
  });
}

/** Re-checks the open collaboration sockets on a drive (hook registered by lib/dochub.js). */
function revalidateDrive(driveId) {
  const hook = globalThis.__aindrive_dochub_revalidate;
  return typeof hook === "function" ? hook(driveId) : 0;
}

/**
 * After an organization's membership changed (the provisioning adapter):
 * open sockets on its drives are re-checked, so a creator's suspension
 * closes the org members' editors too. Returns how many sockets closed.
 */
export function revalidateOrgDrives(issuer, orgId) {
  let closed = 0;
  for (const r of db.prepare("SELECT drive_id FROM drive_org_shares WHERE issuer = ? AND org_id = ?").all(issuer, orgId)) {
    closed += revalidateDrive(r.drive_id);
  }
  return closed;
}

/**
 * Shares the whole drive with an organization (or changes its role). The
 * caller decided the actor may (checkOrgShare, or the operator script).
 * Audited in sso_audit. Returns the previous role (null = new share).
 */
export function shareDriveWithOrg({ driveId, issuer, orgId, role, actor, actorUserId = null, subject = null, via = null }) {
  if (!ORG_SHARE_ROLES.includes(role)) throw new Error(`invalid organization role: ${role}`);
  const previousRole = db.transaction(() => {
    const prev = db.prepare("SELECT role FROM drive_org_shares WHERE drive_id = ? AND issuer = ? AND org_id = ?").get(driveId, issuer, orgId);
    const t = now();
    db.prepare(
      `INSERT INTO drive_org_shares (drive_id, issuer, org_id, role, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(drive_id, issuer, org_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
    ).run(driveId, issuer, orgId, role, actorUserId ?? actor, t, t);
    if (!prev || prev.role !== role) {
      audit({
        actor, action: prev ? "org_drive_role_changed" : "org_drive_shared", issuer, subject, orgId, userId: actorUserId,
        details: { driveId, role, previousRole: prev?.role ?? null, via },
      });
    }
    return prev?.role ?? null;
  }).immediate();
  if (previousRole && previousRole !== role) revalidateDrive(driveId);
  return { previousRole };
}

/**
 * Stops sharing the drive with an organization (every issuer's row for that
 * org id when `issuer` is omitted). Open sockets of people who lose access
 * close. Audited. Returns how many shares were removed.
 */
export function unshareDriveFromOrg({ driveId, orgId, issuer = null, actor, actorUserId = null, subject = null }) {
  const removed = db.transaction(() => {
    const rows = issuer
      ? db.prepare("SELECT issuer, role FROM drive_org_shares WHERE drive_id = ? AND org_id = ? AND issuer = ?").all(driveId, orgId, issuer)
      : db.prepare("SELECT issuer, role FROM drive_org_shares WHERE drive_id = ? AND org_id = ?").all(driveId, orgId);
    for (const r of rows) {
      db.prepare("DELETE FROM drive_org_shares WHERE drive_id = ? AND issuer = ? AND org_id = ?").run(driveId, r.issuer, orgId);
      audit({ actor, action: "org_drive_unshared", issuer: r.issuer, subject, orgId, userId: actorUserId, details: { driveId, role: r.role } });
    }
    return rows.length;
  }).immediate();
  if (removed > 0) revalidateDrive(driveId);
  return removed;
}

/**
 * Organizations known from sso_memberships whose id or slug is `query`
 * (the operator script's `--org`). Several = ambiguous (e.g. two issuers).
 */
export function findOrgs(query) {
  const q = String(query ?? "").trim();
  if (!q) return [];
  return db.prepare(
    "SELECT DISTINCT issuer, org_id FROM sso_memberships WHERE org_id = ? OR org_slug = ? ORDER BY issuer, org_id",
  ).all(q, q).map((r) => ({ issuer: r.issuer, orgId: r.org_id, ...orgInfo(r.issuer, r.org_id) }));
}

/** Every organization sso_memberships knows, with member counts and bound drives (operator script). */
export function listKnownOrgs() {
  return db.prepare(
    `SELECT issuer, org_id, COUNT(DISTINCT user_id) AS members,
            COUNT(DISTINCT CASE WHEN status = 'active' THEN user_id END) AS active_rows
     FROM sso_memberships GROUP BY issuer, org_id ORDER BY issuer, org_id`,
  ).all().map((r) => ({
    issuer: r.issuer,
    orgId: r.org_id,
    ...orgInfo(r.issuer, r.org_id),
    members: r.members,
    activeMembers: r.active_rows,
    drives: db.prepare(
      "SELECT s.drive_id, s.role, d.name FROM drive_org_shares s LEFT JOIN drives d ON d.id = s.drive_id WHERE s.issuer = ? AND s.org_id = ? ORDER BY s.created_at",
    ).all(r.issuer, r.org_id).map((x) => ({ driveId: x.drive_id, name: x.name, role: x.role })),
  }));
}
