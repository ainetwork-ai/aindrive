// Pure rules for organization sharing (docs/PERMISSIONS.md "Organizations").
// No DB, no env reads: lib/orgs.js applies them to the database, boot-checks.js
// validates the allowlist with the same parser, and the tests call them
// directly. Plain ESM (+ org-policy.d.ts) for the same reason as access-core.js.

/** Roles a drive can give an organization. Never "owner": org membership never manages a drive. */
export const ORG_SHARE_ROLES = Object.freeze(["viewer", "editor"]);

/** AIN SSO app roles (sso_memberships.app_role) that may share a drive with their organization. */
export const ORG_ADMIN_APP_ROLES = Object.freeze(["admin", "owner"]);

/**
 * AINDRIVE_ORG_SHARE_ALLOWLIST — comma-separated `<org>:<account>` entries.
 * `<org>` is the organization's slug or id; `<account>` is the aindrive user id
 * or the AIN subject of a person who may share their own drives with that
 * organization although AIN SSO does not make them an org admin. Both are
 * stable identifiers; an email address is not accepted (addresses get
 * reassigned, lib/sso/README.md).
 *
 * @param {string | null | undefined} raw
 * @returns {{ entries: Array<{ org: string, account: string }>, bad: string[] }}
 */
export function parseOrgShareAllowlist(raw) {
  const entries = [];
  const bad = [];
  for (const part of String(raw ?? "").split(",")) {
    const t = part.trim();
    if (!t) continue;
    const m = /^([^\s:@]+):([^\s:@]+)$/.exec(t);
    if (m) entries.push({ org: m[1], account: m[2] });
    else bad.push(t);
  }
  return { entries, bad };
}

/**
 * May this person share (or re-role) their drive with this organization?
 *
 *  - only the drive's creator (drives.owner_id) — co-owners manage people and
 *    links, not who the drive is published to;
 *  - only with an organization they are an ACTIVE member of;
 *  - and only as an org admin (AIN SSO app role `admin`/`owner`), or when the
 *    operator allowlisted them for that organization.
 *
 * Unsharing is not gated by this: the creator may always take a share back.
 *
 * @param {{
 *   isCreator: boolean,
 *   userId: string,
 *   membership: { orgId: string, slug: string | null, subject: string, appRole: string | null, active: boolean } | null,
 *   allowlist: Array<{ org: string, account: string }>,
 * }} input
 * @returns {{ ok: true, via: "org_admin" | "allowlist" } | { ok: false, status: number, error: string }}
 */
export function orgShareDecision({ isCreator, userId, membership, allowlist }) {
  if (!isCreator) return { ok: false, status: 403, error: "only the drive creator can share it with an organization" };
  if (!membership || !membership.active) return { ok: false, status: 403, error: "you are not an active member of that organization" };
  if (membership.appRole && ORG_ADMIN_APP_ROLES.includes(membership.appRole)) return { ok: true, via: "org_admin" };
  const listed = allowlist.some(
    (e) => (e.org === membership.orgId || (!!membership.slug && e.org === membership.slug)) &&
      (e.account === userId || e.account === membership.subject),
  );
  if (listed) return { ok: true, via: "allowlist" };
  return { ok: false, status: 403, error: "only an organization admin can share a drive with the organization" };
}

/**
 * Where a person lands right after signing in (docs/PERMISSIONS.md
 * "Organizations"): an explicit destination is kept; the home page ("/") is
 * replaced by the organization's drive on a first sign-in or when the person
 * has no personal drive, so a company folder is the first thing they see.
 * Several organization drives land on the home page, which lists them first.
 *
 * @param {{ nextPath: string, firstSignIn: boolean, ownsPersonalDrive: boolean, orgDriveIds: string[] }} input
 * @returns {string}
 */
export function landingPath({ nextPath, firstSignIn, ownsPersonalDrive, orgDriveIds }) {
  if (nextPath !== "/") return nextPath;
  if (!firstSignIn && ownsPersonalDrive) return nextPath;
  const ids = [...new Set(orgDriveIds)];
  return ids.length === 1 ? `/d/${encodeURIComponent(ids[0])}` : nextPath;
}
