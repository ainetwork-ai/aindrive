// Types for lib/org-policy.js (plain ESM: boot-checks.js and lib/orgs.js import it under `node server.js`).

export type OrgShareRole = "viewer" | "editor";
export declare const ORG_SHARE_ROLES: readonly OrgShareRole[];
export declare const ORG_ADMIN_APP_ROLES: readonly string[];

export type OrgShareAllowEntry = { org: string; account: string };
export declare function parseOrgShareAllowlist(raw: string | null | undefined): { entries: OrgShareAllowEntry[]; bad: string[] };

export type OrgShareMembership = { orgId: string; slug: string | null; subject: string; appRole: string | null; active: boolean };
export type OrgShareRefusal = "not_creator" | "not_member" | "not_admin";
export type OrgShareDecision =
  | { ok: true; via: "org_admin" | "allowlist" }
  | { ok: false; status: number; code?: OrgShareRefusal; error: string };
export declare function orgShareDecision(input: {
  isCreator: boolean;
  userId: string;
  membership: OrgShareMembership | null;
  allowlist: OrgShareAllowEntry[];
}): OrgShareDecision;

export declare function landingPath(input: {
  nextPath: string;
  firstSignIn: boolean;
  ownsPersonalDrive: boolean;
  orgDriveIds: string[];
}): string;

export type OrgSectionState = "drives" | "paused" | "empty" | "empty-compact";
export declare function orgSectionState(input: { drives: number; pausedDrives: number; hasPersonalDrives: boolean }): OrgSectionState;
