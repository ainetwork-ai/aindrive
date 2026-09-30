// Pending invites for emails without an account yet. Registered invitees are
// granted immediately by the members route; only unknown emails land in
// drive_invites, and convert to drive_members the moment that email signs up.
import { nanoid } from "nanoid";
// Relative imports: lib/sso/store.js (plain ESM, also loaded by `node server.js`) uses it.
import { db } from "./db.js";
import { mergeRoleUpgradeOnly } from "./access-core.js";
import { onMemberGranted } from "./share-events-core.js";

// Upsert a pending invite (one row per drive+email+path; re-invite overwrites
// the role — pending grants aren't a security boundary, the owner is editing).
export function addInvite(driveId, email, path, role, createdBy) {
  db.prepare(`
    INSERT INTO drive_invites (id, drive_id, email, path, role, created_by)
    VALUES (?, ?, lower(?), ?, ?, ?)
    ON CONFLICT(drive_id, email, path) DO UPDATE SET role = excluded.role
  `).run(nanoid(12), driveId, email, path, role, createdBy ?? null);
}

export function listInvites(driveId) {
  return db.prepare(
    "SELECT id, email, path, role FROM drive_invites WHERE drive_id = ? ORDER BY created_at DESC",
  ).all(driveId);
}

export function deleteInvite(driveId, inviteId) {
  return db.prepare("DELETE FROM drive_invites WHERE id = ? AND drive_id = ?").run(inviteId, driveId);
}

// Convert every pending invite for this email into a real grant, upgrade-only
// (never lowers a role a prior path-grant already gave), then clear them.
// Called right after the user row is created: legacy signup, and an account
// created through AIN SSO with the AIN-verified address (lib/sso/store.js).
export function claimInvitesForEmail(userId, email) {
  const invites = db.prepare(
    "SELECT id, drive_id, path, role FROM drive_invites WHERE email = lower(?)",
  ).all(email);
  if (invites.length === 0) return 0;
  const grant = db.prepare(`
    INSERT INTO drive_members (id, drive_id, user_id, path, role)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(drive_id, user_id, path) DO UPDATE SET role = ?
  `);
  const readRole = db.prepare(
    "SELECT role FROM drive_members WHERE drive_id = ? AND user_id = ? AND path = ?",
  );
  const drop = db.prepare("DELETE FROM drive_invites WHERE id = ?");
  const tx = db.transaction(() => {
    for (const inv of invites) {
      const existing = readRole.get(inv.drive_id, userId, inv.path);
      const merged = mergeRoleUpgradeOnly(existing?.role ?? "none", inv.role);
      grant.run(nanoid(12), inv.drive_id, userId, inv.path, merged, merged);
      drop.run(inv.id);
      // Change feed: the new account hears `file.shared` for each claimed grant.
      onMemberGranted(inv.drive_id, userId, inv.path);
    }
  });
  tx();
  return invites.length;
}
