// Types for lib/orgs.js (plain ESM so lib/dochub.js and scripts/org-drive.mjs can use it).
import type { DriveRow } from "./drives";
import type { OrgShareDecision, OrgShareMembership, OrgShareRole, OrgShareAllowEntry } from "./org-policy.js";

export type { OrgShareRole };
export type OrgRoleOrNone = "none" | OrgShareRole;

export declare function orgAccessIssuer(): string | null;
export declare function orgShareAllowlist(): OrgShareAllowEntry[];
export declare function orgRoleInDrive(driveId: string, userId: string | null | undefined): OrgRoleOrNone;

export type OrgDriveRow = DriveRow & { org_id: string; org_role: OrgShareRole };
export declare function orgDrivesForUser(userId: string): OrgDriveRow[];

export type UserOrg = { issuer: string; orgId: string; subject: string; appRole: string | null; slug: string | null; name: string };
export declare function userOrgs(userId: string): UserOrg[];
export declare function listOrgDrivesForUser(userId: string): Array<UserOrg & { drives: OrgDriveRow[] }>;

export declare function ownsPersonalDrive(userId: string): boolean;
export declare function signInLandingPath(userId: string, nextPath: string, firstSignIn: boolean): string;
export declare function orgInfo(issuer: string, orgId: string): { slug: string | null; name: string };

export type DriveOrgShare = {
  issuer: string;
  orgId: string;
  slug: string | null;
  name: string;
  role: OrgShareRole;
  activeMembers: number;
  ownerActive: boolean;
  inForce: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};
export declare function listDriveOrgShares(driveId: string): DriveOrgShare[];

export declare function membershipFor(userId: string, issuer: string, orgId: string): OrgShareMembership | null;
export declare function checkOrgShare(
  driveId: string,
  userId: string,
  orgId: string,
): (Extract<OrgShareDecision, { ok: true }> & { issuer: string; membership: OrgShareMembership }) | Extract<OrgShareDecision, { ok: false }>;

export type OrgShareCandidate = { orgId: string; slug: string | null; name: string; canShare: boolean; reason: string | null };
export declare function orgShareCandidates(driveId: string, userId: string): OrgShareCandidate[];

export declare function revalidateOrgDrives(issuer: string, orgId: string): number;
export declare function shareDriveWithOrg(opts: {
  driveId: string;
  issuer: string;
  orgId: string;
  role: OrgShareRole;
  actor: string;
  actorUserId?: string | null;
  subject?: string | null;
  via?: string | null;
}): { previousRole: OrgShareRole | null };
export declare function unshareDriveFromOrg(opts: {
  driveId: string;
  orgId: string;
  issuer?: string | null;
  actor: string;
  actorUserId?: string | null;
  subject?: string | null;
}): number;

export type KnownOrg = { issuer: string; orgId: string; slug: string | null; name: string };
export declare function findOrgs(query: string): KnownOrg[];
export declare function listKnownOrgs(): Array<KnownOrg & { members: number; activeMembers: number; drives: Array<{ driveId: string; name: string | null; role: OrgShareRole }> }>;
