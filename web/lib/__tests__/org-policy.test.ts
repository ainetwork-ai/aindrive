// Pure organization rules (lib/org-policy.js): who may share a drive with an
// organization, the operator allowlist's format, and where a sign-in lands.
import { describe, it, expect } from "vitest";
import { landingPath, orgSectionState, orgShareDecision, parseOrgShareAllowlist } from "../org-policy.js";
import { ssoConfigErrors } from "../boot-checks.js";

const member = (appRole: string | null, active = true) => ({ orgId: "org_1", slug: "comcom", subject: "acc_1", appRole, active });

describe("orgShareDecision", () => {
  it("the creator who is an org admin (or owner) may share", () => {
    expect(orgShareDecision({ isCreator: true, userId: "u1", membership: member("admin"), allowlist: [] })).toEqual({ ok: true, via: "org_admin" });
    expect(orgShareDecision({ isCreator: true, userId: "u1", membership: member("owner"), allowlist: [] })).toEqual({ ok: true, via: "org_admin" });
  });

  it("a plain member may not — unless allowlisted for that org by user id or AIN subject", () => {
    expect(orgShareDecision({ isCreator: true, userId: "u1", membership: member("member"), allowlist: [] })).toMatchObject({ ok: false, status: 403, code: "not_admin" });
    for (const e of [{ org: "comcom", account: "u1" }, { org: "org_1", account: "acc_1" }]) {
      expect(orgShareDecision({ isCreator: true, userId: "u1", membership: member("member"), allowlist: [e] })).toEqual({ ok: true, via: "allowlist" });
    }
    // another org, or another person
    for (const e of [{ org: "acme", account: "u1" }, { org: "comcom", account: "u2" }]) {
      expect(orgShareDecision({ isCreator: true, userId: "u1", membership: member("member"), allowlist: [e] }).ok).toBe(false);
    }
  });

  it("never for a non-creator, a non-member or a suspended member — even an admin or an allowlisted one", () => {
    const allow = [{ org: "comcom", account: "u1" }];
    expect(orgShareDecision({ isCreator: false, userId: "u1", membership: member("admin"), allowlist: allow })).toMatchObject({ ok: false, code: "not_creator" });
    expect(orgShareDecision({ isCreator: true, userId: "u1", membership: null, allowlist: allow })).toMatchObject({ ok: false, code: "not_member" });
    expect(orgShareDecision({ isCreator: true, userId: "u1", membership: member("admin", false), allowlist: allow })).toMatchObject({ ok: false, code: "not_member" });
  });
});

describe("AINDRIVE_ORG_SHARE_ALLOWLIST", () => {
  it("parses <org>:<account> entries and reports the rest", () => {
    expect(parseOrgShareAllowlist(" comcom:u1 , org_2:acc_x,")).toEqual({ entries: [{ org: "comcom", account: "u1" }, { org: "org_2", account: "acc_x" }], bad: [] });
    expect(parseOrgShareAllowlist("comcom:kim@comcom.ai,justorg,a:b:c").bad).toEqual(["comcom:kim@comcom.ai", "justorg", "a:b:c"]);
    expect(parseOrgShareAllowlist(undefined)).toEqual({ entries: [], bad: [] });
  });

  it("a malformed value fails the production boot checks", () => {
    expect(ssoConfigErrors({ AINDRIVE_ORG_SHARE_ALLOWLIST: "comcom:u1" })).toEqual([]);
    expect(ssoConfigErrors({ AINDRIVE_ORG_SHARE_ALLOWLIST: "comcom:kim@comcom.ai" })[0]).toMatch(/AINDRIVE_ORG_SHARE_ALLOWLIST/);
  });
});

describe("landingPath — where a sign-in lands", () => {
  const base = { nextPath: "/", firstSignIn: false, ownsPersonalDrive: true, orgDriveIds: ["d1"] };
  it("an explicit destination is always kept", () => {
    expect(landingPath({ ...base, nextPath: "/d/other", firstSignIn: true, ownsPersonalDrive: false })).toBe("/d/other");
  });
  it("first sign-in → the organization drive", () => {
    expect(landingPath({ ...base, firstSignIn: true })).toBe("/d/d1");
  });
  it("no personal drive → the organization drive, on every sign-in", () => {
    expect(landingPath({ ...base, ownsPersonalDrive: false })).toBe("/d/d1");
  });
  it("a returning person with their own drives → home (the org section is listed first there)", () => {
    expect(landingPath(base)).toBe("/");
  });
  it("several organization drives, or none → home", () => {
    expect(landingPath({ ...base, firstSignIn: true, orgDriveIds: ["d1", "d2"] })).toBe("/");
    expect(landingPath({ ...base, firstSignIn: true, orgDriveIds: [] })).toBe("/");
    expect(landingPath({ ...base, firstSignIn: true, orgDriveIds: ["d1", "d1"] })).toBe("/d/d1");
  });
});

describe("orgSectionState — what the home shows for an organization", () => {
  it("its drives when it has any it can open", () => {
    expect(orgSectionState({ drives: 1, pausedDrives: 1, hasPersonalDrives: true })).toBe("drives");
  });
  it("'paused' (not 'no drive yet') when its only drives are paused", () => {
    expect(orgSectionState({ drives: 0, pausedDrives: 1, hasPersonalDrives: false })).toBe("paused");
    expect(orgSectionState({ drives: 0, pausedDrives: 2, hasPersonalDrives: true })).toBe("paused");
  });
  it("nothing shared yet: the full explanation, or one line above the person's own drives", () => {
    expect(orgSectionState({ drives: 0, pausedDrives: 0, hasPersonalDrives: false })).toBe("empty");
    expect(orgSectionState({ drives: 0, pausedDrives: 0, hasPersonalDrives: true })).toBe("empty-compact");
  });
});
