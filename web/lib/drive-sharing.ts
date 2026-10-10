/**
 * Granting drive access to a person by email, and reading back what access a
 * set of emails has at a path. Shared by the cookie route
 * (app/api/drives/[driveId]/members) and the OAuth routes for third-party apps
 * (app/api/oauth/drives/[driveId]/{members,access-check}, scope drives:share /
 * drives:read), so both enforce the same rules.
 */
import { nanoid } from "nanoid";
import { db } from "./db";
import { getDrive } from "./drives";
import { resolveRole, atLeast } from "./access";
import { isAncestorOrSelf, type NormalizedPath } from "./path.js";
import { addInvite } from "./invites.js";
import { onMemberGranted } from "./share-events";

export type GrantRole = "viewer" | "editor" | "owner";
export type GrantResult = { status: number; body: Record<string, unknown> };

/**
 * `actorId` grants `role` at `path` (normalized) to `email`. Owner-only
 * (creator or co-owner); the owner role is whole-drive and creator-only.
 * An email without an account becomes a pending invite (202) that turns into
 * a membership when that address signs up. Upgrade-only: never lowers a role.
 */
export function grantByEmail(opts: { driveId: string; actorId: string; email: string; path: string; role: GrantRole }): GrantResult {
  const { driveId, actorId, email, path, role } = opts;
  // The owner role is whole-drive only: every management gate resolves at root.
  if (role === "owner" && path !== "") {
    return { status: 400, body: { error: "the owner role can only be granted on the whole drive" } };
  }
  const drive = getDrive(driveId);
  if (!drive) return { status: 404, body: { error: "drive not found" } };
  // Co-owners (owner role via drive_members) may also invite — not just the creator.
  if (!atLeast(resolveRole(driveId, actorId, ""), "owner")) return { status: 403, body: { error: "only owner can invite" } };
  // Minting a co-owner is CREATOR-only.
  if (role === "owner" && drive.owner_id !== actorId) {
    return { status: 403, body: { error: "only the drive creator can grant the owner role" } };
  }
  const invitee = db.prepare("SELECT id FROM users WHERE lower(email) = lower(?)").get(email) as { id: string } | undefined;
  if (!invitee) {
    addInvite(driveId, email, path, role, actorId);
    return { status: 202, body: { ok: true, pending: true } };
  }
  // Upgrade-only upsert (mirrors ROLE_RANK none<viewer<editor<owner).
  db.prepare(`
    INSERT INTO drive_members (id, drive_id, user_id, path, role)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(drive_id, user_id, path) DO UPDATE SET role =
      CASE
        WHEN (CASE drive_members.role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END)
           > (CASE excluded.role       WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END)
        THEN drive_members.role
        ELSE excluded.role
      END
  `).run(nanoid(12), driveId, invitee.id, path, role);
  // Change feed: the invitee (and only they) hears `file.shared` for the grant path.
  onMemberGranted(driveId, invitee.id, path);
  return { status: 200, body: { ok: true, pending: false } };
}

export type Access = "owner" | "editor" | "viewer" | "pending" | "none";

/**
 * Effective access of each email at `path`: the account's role (owner, member
 * rows covering the path, organization grants), else "pending" when an invite
 * covering the path waits for that address to sign up, else "none". The value
 * is the same for "no account" and "account without access", so the answer
 * does not reveal whether an address has an account.
 */
export function accessForEmails(driveId: string, path: string, emails: string[]): { email: string; access: Access }[] {
  const findUser = db.prepare("SELECT id FROM users WHERE lower(email) = lower(?)");
  const invites = db.prepare("SELECT path, role FROM drive_invites WHERE drive_id = ? AND email = lower(?)");
  return emails.map((email) => {
    const user = findUser.get(email) as { id: string } | undefined;
    if (user) {
      const role = resolveRole(driveId, user.id, path);
      if (role !== "none") return { email, access: role as Access };
    }
    const pending = (invites.all(driveId, email) as { path: string }[]).some((i) => isAncestorOrSelf(i.path as NormalizedPath, path as NormalizedPath));
    return { email, access: pending ? "pending" : "none" };
  });
}
