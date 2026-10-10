// lib/git-slug.ts: the friendly git URL /<slug>/git/<repo> finds its drive by
// AIN SSO organization slug (rule in the module header). It only locates the
// drive; access is decided afterwards by requireDriveRole in lib/git-http.ts.
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-git-slug-"));
process.env.AINDRIVE_SESSION_SECRET = "git-slug-test-secret-0123456789abcdef";
process.env.AINDRIVE_PUBLIC_URL = "https://drive.example.test";
const ISSUER = "https://sso.example.test";
const OTHER_ISSUER = "https://sso-other.example.test";
process.env.AINDRIVE_SSO_ISSUER = ISSUER;
process.env.AINDRIVE_SSO_CLIENT_ID = "app_aindrive";

const { db } = await import("../db.js");
const { resolveGitSlug, RESERVED } = await import("../git-slug");
const orgs = await import("../orgs.js");

const COMCOM = { id: "org_comcom", slug: "comcom", name: "ComCom" }; // one shared drive
const ACME = { id: "org_acme", slug: "acme", name: "Acme" };         // two shared drives, one named "Acme"
const DUO = { id: "org_duo", slug: "duo", name: "Duo" };             // two shared drives, neither named "duo"
const LONE = { id: "org_lone", slug: "lone", name: "Lone" };         // an org with no shared drive
const FAR = { id: "org_far", slug: "far", name: "Far" };             // under another issuer

function membership(userId: string, sub: string, org: typeof COMCOM, status = "active", issuer = ISSUER) {
  db.prepare(
    `INSERT INTO sso_memberships (issuer, org_id, subject, user_id, org_slug, org_name, status, app_role, groups_json, applied_version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'member', '[]', 1, ?)`,
  ).run(issuer, org.id, sub, userId, org.slug, org.name, status, Date.now());
}
const share = (driveId: string, org: typeof COMCOM, issuer = ISSUER) =>
  orgs.shareDriveWithOrg({ driveId, issuer, orgId: org.id, role: "viewer", actor: "operator", via: "operator" });

beforeAll(() => {
  const u = db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)");
  for (const id of ["u1", "u2", "u3"]) u.run(id, `${id}@example.com`, id, "x");
  const d = db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)");
  d.run("d-comcom", "u1", "ComCom Drive", "h", "s");
  d.run("d-acme-main", "u1", "ACME", "h", "s");       // name matches slug `acme` case-insensitively
  d.run("d-acme-other", "u1", "Acme Archive", "h", "s");
  d.run("d-duo-1", "u2", "First", "h", "s");
  d.run("d-duo-2", "u2", "Second", "h", "s");
  d.run("d-far", "u3", "Far", "h", "s");
  d.run("d-unshared", "u3", "comcom", "h", "s");      // named like an org slug but not shared with it

  membership("u1", "acc_1", COMCOM); membership("u1", "acc_1", ACME);
  membership("u2", "acc_2", DUO); membership("u2", "acc_2", LONE);
  membership("u3", "acc_3", FAR, "active", OTHER_ISSUER);
  share("d-comcom", COMCOM);
  share("d-acme-main", ACME); share("d-acme-other", ACME);
  share("d-duo-1", DUO); share("d-duo-2", DUO);
  share("d-far", FAR, OTHER_ISSUER);
});

describe("resolveGitSlug", () => {
  it("refuses reserved top-level app names", () => {
    for (const r of ["api", "mcp", "a2a", "d", "s", "docs", "login", "signup", "sso", "oauth", "account", "download", "cli-login", "agui", "ainui", "forgot-password", "_next", "_dev"]) {
      expect(RESERVED.has(r), r).toBe(true);
      expect(resolveGitSlug(r), r).toBeNull();
    }
    expect(resolveGitSlug("API")).toBeNull();
    expect(resolveGitSlug("")).toBeNull();
  });

  it("an org slug with one shared drive → that drive", () => {
    expect(resolveGitSlug("comcom")).toBe("d-comcom");
  });

  it("is case-insensitive on the org slug", () => {
    expect(resolveGitSlug("ComCom")).toBe("d-comcom");
    expect(resolveGitSlug("COMCOM")).toBe("d-comcom");
  });

  it("two shared drives → the one named like the slug (case-insensitively)", () => {
    expect(resolveGitSlug("acme")).toBe("d-acme-main");
    expect(resolveGitSlug("Acme")).toBe("d-acme-main");
  });

  it("two shared drives, none named like the slug → null", () => {
    expect(resolveGitSlug("duo")).toBeNull();
  });

  it("an org with no shared drive, and an unknown slug → null", () => {
    expect(resolveGitSlug("lone")).toBeNull();
    expect(resolveGitSlug("nobody")).toBeNull();
    expect(resolveGitSlug("d-comcom")).toBeNull(); // a drive id is not a slug
  });

  it("matches org slugs under any issuer", () => {
    expect(resolveGitSlug("far")).toBe("d-far");
  });

  it("a drive merely NAMED like a slug is not found through it", () => {
    // d-unshared is named "comcom" but only d-comcom is shared with the org.
    expect(resolveGitSlug("comcom")).toBe("d-comcom");
  });

  it("ignores the membership's status: the slug names the org, not a person", () => {
    membership("u3", "acc_3b", COMCOM, "suspended");
    expect(resolveGitSlug("comcom")).toBe("d-comcom");
  });
});
