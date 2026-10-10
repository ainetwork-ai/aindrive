// Organizations (docs/PERMISSIONS.md "Organizations", lib/orgs.js): a drive
// shared with an AIN SSO organization gives every ACTIVE member its role on
// the whole drive — through the same access functions every route uses — and
// nothing to anyone else: non-members, other organizations, suspended or
// deprovisioned members, or anyone once the drive's creator stopped being an
// active member. The viewer role stays a viewer everywhere (no writes, no
// editor links); the creator stays the owner.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-orgs-"));
process.env.AINDRIVE_SESSION_SECRET = "orgs-test-secret-0123456789abcdef0123";
process.env.AINDRIVE_PUBLIC_URL = "https://drive.example.test";
const ISSUER = "https://sso.example.test";
process.env.AINDRIVE_SSO_ISSUER = ISSUER;
process.env.AINDRIVE_SSO_CLIENT_ID = "app_aindrive";

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => { cookieJar.set(name, value); },
    delete: (name: string) => { cookieJar.delete(name); },
  }),
}));

// An always-online agent: routes that pass the gate get an answer.
const agentCalls: { method: string; path: string }[] = [];
vi.mock("../rpc", () => ({
  AgentError: class extends Error { status = 502; },
  isOnline: () => true,
  callAgent: async (_d: string, _s: string, req: { method: string; path: string }) => {
    agentCalls.push({ method: req.method, path: req.path });
    if (req.method === "list") return { entries: [{ name: "handbook.md", isDir: false }] };
    if (req.method === "read") return { content: "company handbook" };
    if (req.method === "stat") return { entry: { name: req.path, isDir: true } };
    return { ok: true };
  },
}));

const { db } = await import("../db.js");
const { sign } = await import("../session");
const access = await import("../access");
const orgs = await import("../orgs.js");
const { maxRoleInDrive, clampScope } = await import("../mcp-tokens");
const { listUserDrives } = await import("../drives");
const { applyDesiredState } = await import("../sso/store.js");
const { runSkill } = await import("../../shared/agent-skills");
const { onDocConnect } = await import("../dochub.js");
const fsList = await import("../../app/api/drives/[driveId]/fs/list/route.js");
const fsRead = await import("../../app/api/drives/[driveId]/fs/read/route.js");
const fsWrite = await import("../../app/api/drives/[driveId]/fs/write/route.js");
const sharesRoute = await import("../../app/api/drives/[driveId]/shares/route.js");
const membersRoute = await import("../../app/api/drives/[driveId]/members/route.js");
const leaveRoute = await import("../../app/api/drives/[driveId]/leave/route.js");
const showcaseRoute = await import("../../app/api/drives/[driveId]/showcase/route.js");
const drivesRoute = await import("../../app/api/drives/route.js");
const orgsRoute = await import("../../app/api/drives/[driveId]/orgs/route.js");
const orgRoute = await import("../../app/api/drives/[driveId]/orgs/[orgId]/route.js");

const COMCOM = { id: "org_comcom", slug: "comcom", name: "ComCom" };
const ACME = { id: "org_acme", slug: "acme", name: "Acme" };

// People
const OWNER = "u-owner";     // creates the ComCom drive; ComCom admin
const MEMBER = "u-member";   // ComCom member
const OUTSIDER = "u-out";    // no organization at all
const OTHER = "u-other";     // Acme member only
const SPLIT = "u-split";     // Acme active, ComCom suspended (a live session, no ComCom)
const DEPROV = "u-deprov";   // Acme active, ComCom deprovisioned
const DOUBLE = "u-double";   // two ComCom rows, one suspended: the suspension wins
const CO = "u-co";           // ComCom member and co-owner (drive_members owner) of DRIVE
const PLAIN = "u-plain";     // ComCom member (not admin) with a drive of their own

const DRIVE = "d-comcom";    // OWNER's, shared with ComCom as viewer
const EDIT_DRIVE = "d-team"; // OWNER's, shared with ComCom as editor
const PLAIN_DRIVE = "d-plain";

const ctx = (driveId: string) => ({ params: Promise.resolve({ driveId }) });
async function as(userId: string | null) {
  cookieJar.clear();
  if (userId) cookieJar.set("aindrive_session", await sign(userId));
}
const get = (url: string) => new Request(`https://drive.example.test${url}`);
const json = (url: string, method: string, body: unknown) =>
  new Request(`https://drive.example.test${url}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function membership(userId: string, sub: string, org: typeof COMCOM, status: string, appRole: string | null = "member", version = 1) {
  db.prepare(
    `INSERT INTO sso_memberships (issuer, org_id, subject, user_id, org_slug, org_name, status, app_role, groups_json, applied_version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
  ).run(ISSUER, org.id, sub, userId, org.slug, org.name, status, appRole, version, Date.now());
}
function identity(userId: string, sub: string) {
  db.prepare("INSERT INTO sso_identities (issuer, subject, user_id, link_method, linked_at) VALUES (?, ?, ?, 'provisioned', ?)")
    .run(ISSUER, sub, userId, Date.now());
}
/** What the provisioning adapter applies (the real transition path). */
function push(sub: string, org: typeof COMCOM, status: "active" | "suspended" | "deprovisioned", version: number, appRole = "member") {
  return applyDesiredState(ISSUER, {
    schema: "ain-sso.adapter.v1", sub, org, version, status,
    profile: { name: null, email: null, workEmail: null },
    appRole: status === "active" ? appRole : null, groups: [], legacyUserId: null, ownershipTransferTo: null, issuedAt: new Date().toISOString(),
  });
}

beforeAll(() => {
  const u = db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)");
  for (const id of [OWNER, MEMBER, OUTSIDER, OTHER, SPLIT, DEPROV, DOUBLE, CO, PLAIN]) u.run(id, `${id}@example.com`, id, "x");
  const d = db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)");
  d.run(DRIVE, OWNER, "ComCom", "h", "s");
  d.run(EDIT_DRIVE, OWNER, "Team", "h", "s");
  d.run(PLAIN_DRIVE, PLAIN, "Plain's", "h", "s");
  db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)").run("m-co", DRIVE, CO, "", "owner");

  identity(OWNER, "acc_owner"); membership(OWNER, "acc_owner", COMCOM, "active", "admin");
  identity(MEMBER, "acc_member"); membership(MEMBER, "acc_member", COMCOM, "active");
  membership(OTHER, "acc_other", ACME, "active");
  membership(SPLIT, "acc_split", ACME, "active"); membership(SPLIT, "acc_split", COMCOM, "suspended", null);
  membership(DEPROV, "acc_deprov", ACME, "active"); membership(DEPROV, "acc_deprov", COMCOM, "deprovisioned", null);
  membership(DOUBLE, "acc_double1", COMCOM, "active"); membership(DOUBLE, "acc_double2", COMCOM, "suspended", null);
  membership(CO, "acc_co", COMCOM, "active", "admin");
  membership(PLAIN, "acc_plain", COMCOM, "active", "member");

  orgs.shareDriveWithOrg({ driveId: DRIVE, issuer: ISSUER, orgId: COMCOM.id, role: "viewer", actor: "operator", via: "operator" });
  orgs.shareDriveWithOrg({ driveId: EDIT_DRIVE, issuer: ISSUER, orgId: COMCOM.id, role: "editor", actor: "operator", via: "operator" });
});

afterEach(() => { delete process.env.AINDRIVE_ORG_SHARE_ALLOWLIST; });

describe("central access check (resolveRoleByUser / resolveAccess)", () => {
  it("an active member gets the org's role on the whole drive, at any path", async () => {
    expect(access.resolveRoleByUser(DRIVE, MEMBER, "")).toBe("viewer");
    expect(access.resolveRoleByUser(DRIVE, MEMBER, "hr/policies/leave.md")).toBe("viewer");
    expect(await access.resolveAccess(EDIT_DRIVE, "notes", MEMBER)).toBe("editor");
  });

  it("the creator stays the owner", () => {
    expect(access.resolveRoleByUser(DRIVE, OWNER, "")).toBe("owner");
  });

  it.each([
    ["a non-member", OUTSIDER],
    ["a member of another organization", OTHER],
    ["a suspended member", SPLIT],
    ["a deprovisioned member", DEPROV],
    ["a member with any non-active row for that org", DOUBLE],
  ])("%s gets nothing", (_label, who) => {
    expect(access.resolveRoleByUser(DRIVE, who, "")).toBe("none");
    expect(orgs.orgRoleInDrive(DRIVE, who)).toBe("none");
  });

  it("merges with personal grants by rank — never lowers one", () => {
    db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)").run("m-mem-docs", DRIVE, MEMBER, "docs", "editor");
    expect(access.resolveRoleByUser(DRIVE, MEMBER, "docs/a.md")).toBe("editor");
    expect(access.resolveRoleByUser(DRIVE, MEMBER, "other/a.md")).toBe("viewer");
    db.prepare("DELETE FROM drive_members WHERE id = 'm-mem-docs'").run();
  });

  it("members enter the drive at its root", () => {
    expect(access.entryView(DRIVE, MEMBER)).toEqual({ kind: "root", path: "" });
    expect(access.entryView(DRIVE, OUTSIDER)).toEqual({ kind: "none" });
  });

  it("is off while the provisioning adapter is not configured (memberships nobody keeps current)", () => {
    const saved = process.env.AINDRIVE_SSO_CLIENT_ID;
    delete process.env.AINDRIVE_SSO_CLIENT_ID;
    try {
      expect(access.resolveRoleByUser(DRIVE, MEMBER, "")).toBe("none");
      expect(listUserDrives(MEMBER).map((d) => d.id)).not.toContain(DRIVE);
    } finally { process.env.AINDRIVE_SSO_CLIENT_ID = saved; }
    expect(access.resolveRoleByUser(DRIVE, MEMBER, "")).toBe("viewer");
  });
});

describe("suspension and offboarding through the adapter end access at once", () => {
  it("member suspended → none; reactivated → back", () => {
    expect(access.resolveRoleByUser(DRIVE, MEMBER, "")).toBe("viewer");
    push("acc_member", COMCOM, "suspended", 2);
    expect(access.resolveRoleByUser(DRIVE, MEMBER, "")).toBe("none");
    expect(maxRoleInDrive(DRIVE, MEMBER)).toBe("none");
    push("acc_member", COMCOM, "active", 3);
    expect(access.resolveRoleByUser(DRIVE, MEMBER, "")).toBe("viewer");
  });

  it("the creator suspended or offboarded → the share pauses for everyone; reactivated → resumes", () => {
    push("acc_owner", COMCOM, "suspended", 2, "admin");
    expect(access.resolveRoleByUser(DRIVE, MEMBER, "")).toBe("none");
    expect(orgs.listDriveOrgShares(DRIVE)[0]).toMatchObject({ inForce: false, ownerActive: false });
    push("acc_owner", COMCOM, "active", 3, "admin");
    expect(access.resolveRoleByUser(DRIVE, MEMBER, "")).toBe("viewer");
    expect(orgs.listDriveOrgShares(DRIVE)[0]).toMatchObject({ inForce: true, role: "viewer", name: "ComCom", slug: "comcom" });
  });
});

describe("route level: members read, viewers can't write or mint editor links", () => {
  it("fs/list and fs/read: member 200, non-member / other org / suspended 403, anonymous 401", async () => {
    await as(MEMBER);
    const list = await fsList.GET(get(`/api/drives/${DRIVE}/fs/list?path=`), ctx(DRIVE));
    expect(list.status).toBe(200);
    expect((await list.json()).role).toBe("viewer");
    const read = await fsRead.GET(get(`/api/drives/${DRIVE}/fs/read?path=handbook.md`), ctx(DRIVE));
    expect(read.status).toBe(200);
    expect((await read.json()).content).toBe("company handbook");
    for (const who of [OUTSIDER, OTHER, SPLIT, DEPROV]) {
      await as(who);
      expect((await fsList.GET(get(`/api/drives/${DRIVE}/fs/list?path=`), ctx(DRIVE))).status, who).toBe(403);
      expect((await fsRead.GET(get(`/api/drives/${DRIVE}/fs/read?path=handbook.md`), ctx(DRIVE))).status, who).toBe(403);
    }
    await as(null);
    expect((await fsList.GET(get(`/api/drives/${DRIVE}/fs/list?path=`), ctx(DRIVE))).status).toBe(401);
  });

  it("fs/write: an org viewer is refused; an org editor writes", async () => {
    await as(MEMBER);
    const body = { path: "notes.md", content: "hi" };
    expect((await fsWrite.POST(json(`/api/drives/${DRIVE}/fs/write`, "POST", body), ctx(DRIVE))).status).toBe(403);
    agentCalls.length = 0;
    const ok = await fsWrite.POST(json(`/api/drives/${EDIT_DRIVE}/fs/write`, "POST", body), ctx(EDIT_DRIVE));
    expect(ok.status).toBe(200);
    expect(agentCalls.some((c) => c.method === "write" && c.path === "notes.md")).toBe(true);
  });

  it("share links: an organization's role never mints one — viewer or editor (a link is a durable grant)", async () => {
    await as(MEMBER);
    expect((await sharesRoute.POST(json(`/api/drives/${DRIVE}/shares`, "POST", { path: "", role: "viewer" }), ctx(DRIVE))).status).toBe(403);
    expect((await sharesRoute.POST(json(`/api/drives/${DRIVE}/shares`, "POST", { path: "", role: "editor" }), ctx(DRIVE))).status).toBe(403);
    const viewerLink = await sharesRoute.POST(json(`/api/drives/${EDIT_DRIVE}/shares`, "POST", { path: "", role: "viewer" }), ctx(EDIT_DRIVE));
    expect(viewerLink.status).toBe(403);
    expect((await viewerLink.json()).error).toMatch(/organization/);
    const editorLink = await sharesRoute.POST(json(`/api/drives/${EDIT_DRIVE}/shares`, "POST", { path: "", role: "editor" }), ctx(EDIT_DRIVE));
    expect(editorLink.status).toBe(403);
    // Their own grant (an invitation) still lets them pass on what it covers.
    db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)").run("m-mem-team", EDIT_DRIVE, MEMBER, "docs", "editor");
    expect((await sharesRoute.POST(json(`/api/drives/${EDIT_DRIVE}/shares`, "POST", { path: "docs", role: "viewer" }), ctx(EDIT_DRIVE))).status).toBe(200);
    expect((await sharesRoute.POST(json(`/api/drives/${EDIT_DRIVE}/shares`, "POST", { path: "other", role: "viewer" }), ctx(EDIT_DRIVE))).status).toBe(403);
    db.prepare("DELETE FROM drive_members WHERE id = 'm-mem-team'").run();
  });

  it("members roster and invites stay owner/editor surfaces", async () => {
    await as(MEMBER);
    expect((await membersRoute.GET(get(`/api/drives/${DRIVE}/members`), ctx(DRIVE))).status).toBe(403);
    const invite = await membersRoute.POST(json(`/api/drives/${EDIT_DRIVE}/members`, "POST", { email: "x@example.com", role: "viewer" }), ctx(EDIT_DRIVE));
    expect(invite.status).toBe(403);
  });

  it("the drive list shows the org drive to members only, tagged with the organization", async () => {
    await as(MEMBER);
    const res = await drivesRoute.GET();
    const drives = (await res.json()).drives as { id: string; owned: boolean; org: { id: string; name: string } | null }[];
    expect(drives.find((d) => d.id === DRIVE)).toMatchObject({ owned: false, org: { id: COMCOM.id, name: "ComCom" } });
    for (const who of [OUTSIDER, OTHER, SPLIT]) {
      expect(listUserDrives(who).map((d) => d.id), who).not.toContain(DRIVE);
    }
  });

  it("leaving is not how org access ends (409, nothing deleted); the showcase treats members as related", async () => {
    await as(MEMBER);
    const res = await leaveRoute.POST(get(`/api/drives/${DRIVE}/leave`), ctx(DRIVE));
    expect(res.status).toBe(409);
    expect(access.resolveRoleByUser(DRIVE, MEMBER, "")).toBe("viewer");
    expect((await showcaseRoute.GET(get(`/api/drives/${DRIVE}/showcase`), ctx(DRIVE))).status).toBe(200);
    await as(OTHER);
    expect((await showcaseRoute.GET(get(`/api/drives/${DRIVE}/showcase`), ctx(DRIVE))).status).toBe(403);
  });
});

describe("MCP / agent access", () => {
  it("scope ceiling: org viewer → read only; org editor → write", () => {
    expect(maxRoleInDrive(DRIVE, MEMBER)).toBe("viewer");
    expect(clampScope(DRIVE, MEMBER, "write")).toBe("read");
    expect(clampScope(EDIT_DRIVE, MEMBER, "write")).toBe("write");
    expect(clampScope(DRIVE, OTHER, "read")).toBeNull();
  });

  it("skills: the member reads and lists drives, cannot write; others are refused", async () => {
    const member = { userId: MEMBER, driveId: DRIVE, scope: "write" as const };
    expect((await runSkill(member, "read_file", { path: "handbook.md" })).kind).toBe("ok");
    const w = await runSkill(member, "write_file", { path: "x.md", content: "x" });
    expect(w).toMatchObject({ kind: "err", code: "forbidden" });
    const other = await runSkill({ userId: OTHER, driveId: DRIVE, scope: "read" }, "read_file", { path: "handbook.md" });
    expect(other).toMatchObject({ kind: "err", code: "forbidden" });
    const listed = await runSkill({ userId: MEMBER }, "list_drives", {});
    expect(listed.kind === "ok" && (listed.structured as { drives: { id: string; role: string }[] }).drives).toContainEqual({ id: DRIVE, name: "ComCom", role: "viewer", orgId: COMCOM.id });
  });
});

describe("collaboration websocket", () => {
  type FakeWs = { closedWith: number | null; sent: string[]; readyState: number; OPEN: number; close(code: number): void; send(s: string): void; on(): void };
  const fakeWs = (): FakeWs => ({ closedWith: null, sent: [], readyState: 1, OPEN: 1, close(code) { this.closedWith = code; }, send(s) { this.sent.push(s); }, on() {} });
  async function connect(userId: string, driveId: string) {
    const jwt = await sign(userId);
    const ws = fakeWs();
    await onDocConnect(ws, { headers: { cookie: `aindrive_session=${jwt}` } }, { drive: driveId, path: "handbook.md" });
    return ws;
  }

  it("a member subscribes as viewer, an outsider is closed", async () => {
    const ws = await connect(MEMBER, DRIVE);
    expect(ws.closedWith).toBeNull();
    expect(JSON.parse(ws.sent[0])).toMatchObject({ t: "sub-ok", role: "viewer" });
    expect((await connect(OTHER, DRIVE)).closedWith).toBe(4401);
  });

  it("lowering or removing the org share closes open sockets that lost their role", async () => {
    const tmp = "d-ws";
    db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)").run(tmp, OWNER, "WS", "h", "s");
    orgs.shareDriveWithOrg({ driveId: tmp, issuer: ISSUER, orgId: COMCOM.id, role: "editor", actor: "test" });
    const editor = await connect(MEMBER, tmp);
    const owner = await connect(OWNER, tmp);
    expect(JSON.parse(editor.sent[0]).role).toBe("editor");
    orgs.shareDriveWithOrg({ driveId: tmp, issuer: ISSUER, orgId: COMCOM.id, role: "viewer", actor: "test" });
    expect(editor.closedWith).toBe(4401);
    const viewer = await connect(MEMBER, tmp);
    expect(JSON.parse(viewer.sent[0]).role).toBe("viewer");
    orgs.unshareDriveFromOrg({ driveId: tmp, orgId: COMCOM.id, actor: "test" });
    expect(viewer.closedWith).toBe(4401);
    expect(owner.closedWith).toBeNull();
  });
});

describe("management: share / unshare from the Manage page", () => {
  const url = `/api/drives/${PLAIN_DRIVE}/orgs`;

  it("GET: owners see the shares; only the creator gets candidates; others are refused", async () => {
    await as(OWNER);
    const body = await (await orgsRoute.GET(get(`/api/drives/${DRIVE}/orgs`), ctx(DRIVE))).json();
    expect(body).toMatchObject({ enabled: true, canManage: true });
    expect(body.shares).toEqual([expect.objectContaining({ orgId: COMCOM.id, name: "ComCom", role: "viewer", inForce: true })]);
    expect(body.candidates).toEqual([{ orgId: COMCOM.id, slug: "comcom", name: "ComCom", canShare: true, reason: null, reasonCode: null }]);
    await as(CO);
    const co = await (await orgsRoute.GET(get(`/api/drives/${DRIVE}/orgs`), ctx(DRIVE))).json();
    expect(co).toMatchObject({ canManage: false, candidates: [] });
    await as(MEMBER);
    expect((await orgsRoute.GET(get(`/api/drives/${DRIVE}/orgs`), ctx(DRIVE))).status).toBe(403);
  });

  it("a creator who is only a plain member cannot share with the org (403) and is pointed at the operator…", async () => {
    await as(PLAIN);
    const res = await orgsRoute.POST(json(url, "POST", { orgId: COMCOM.id }), ctx(PLAIN_DRIVE));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/organization admin.*operator/);
    expect(orgs.listDriveOrgShares(PLAIN_DRIVE)).toEqual([]);
    // The Manage card gets a code for its "ask your operator" copy (drive-org-access.tsx).
    const body = await (await orgsRoute.GET(get(url), ctx(PLAIN_DRIVE))).json();
    expect(body.candidates).toEqual([expect.objectContaining({ orgId: COMCOM.id, canShare: false, reasonCode: "not_admin" })]);
  });

  it("…unless the operator allowlisted them for it (by user id or AIN subject, never email)", async () => {
    await as(PLAIN);
    process.env.AINDRIVE_ORG_SHARE_ALLOWLIST = `comcom:${PLAIN}@example.com`;
    expect((await orgsRoute.POST(json(url, "POST", { orgId: COMCOM.id }), ctx(PLAIN_DRIVE))).status).toBe(403);
    process.env.AINDRIVE_ORG_SHARE_ALLOWLIST = "comcom:acc_plain";
    const res = await orgsRoute.POST(json(url, "POST", { orgId: COMCOM.id }), ctx(PLAIN_DRIVE));
    expect(res.status).toBe(201);
    expect(access.resolveRoleByUser(PLAIN_DRIVE, MEMBER, "")).toBe("viewer");
    const audit = db.prepare("SELECT actor, action, org_id, user_id, subject, details FROM sso_audit WHERE action LIKE 'org_drive_%' AND user_id = ? ORDER BY id DESC").get(PLAIN) as { actor: string; action: string; org_id: string; subject: string; details: string };
    expect(audit).toMatchObject({ actor: `user:${PLAIN}`, action: "org_drive_shared", org_id: COMCOM.id, subject: "acc_plain" });
    expect(JSON.parse(audit.details)).toMatchObject({ driveId: PLAIN_DRIVE, role: "viewer", previousRole: null, via: "allowlist" });
  });

  it("only the creator manages it: co-owners, members and strangers are refused", async () => {
    for (const who of [CO, MEMBER, OTHER]) {
      await as(who);
      expect((await orgsRoute.POST(json(`/api/drives/${DRIVE}/orgs`, "POST", { orgId: COMCOM.id, role: "editor" }), ctx(DRIVE))).status, who).toBe(403);
      expect((await orgRoute.DELETE(get(`/api/drives/${DRIVE}/orgs/${COMCOM.id}`), { params: Promise.resolve({ driveId: DRIVE, orgId: COMCOM.id }) })).status, who).toBe(403);
    }
    expect(access.resolveRoleByUser(DRIVE, MEMBER, "")).toBe("viewer");
  });

  it("an org the creator is not an active member of cannot be chosen; roles are viewer | editor only", async () => {
    await as(OWNER);
    expect((await orgsRoute.POST(json(`/api/drives/${DRIVE}/orgs`, "POST", { orgId: ACME.id }), ctx(DRIVE))).status).toBe(403);
    expect((await orgsRoute.POST(json(`/api/drives/${DRIVE}/orgs`, "POST", { orgId: COMCOM.id, role: "owner" }), ctx(DRIVE))).status).toBe(400);
    expect(() => db.prepare("INSERT INTO drive_org_shares (drive_id, issuer, org_id, role, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(DRIVE, ISSUER, "org_x", "owner", "t", 1, 1)).toThrow(/CHECK/);
  });

  it("the creator changes the role and unshares; members lose access at once; both audited", async () => {
    await as(OWNER);
    const up = await orgsRoute.POST(json(`/api/drives/${DRIVE}/orgs`, "POST", { orgId: COMCOM.id, role: "editor" }), ctx(DRIVE));
    expect(up.status).toBe(200);
    expect(await up.json()).toMatchObject({ role: "editor", previousRole: "viewer" });
    expect(access.resolveRoleByUser(DRIVE, MEMBER, "")).toBe("editor");
    const del = await orgRoute.DELETE(get(`/api/drives/${DRIVE}/orgs/${COMCOM.id}`), { params: Promise.resolve({ driveId: DRIVE, orgId: COMCOM.id }) });
    expect(del.status).toBe(200);
    expect(access.resolveRoleByUser(DRIVE, MEMBER, "")).toBe("none");
    expect(access.resolveRoleByUser(DRIVE, OWNER, "")).toBe("owner");
    const actions = (db.prepare("SELECT action FROM sso_audit WHERE user_id = ? AND action LIKE 'org_drive_%' ORDER BY id").all(OWNER) as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(["org_drive_role_changed", "org_drive_unshared"]);
    expect((await orgRoute.DELETE(get(""), { params: Promise.resolve({ driveId: DRIVE, orgId: COMCOM.id }) })).status).toBe(404);
    // Restore for anything after.
    orgs.shareDriveWithOrg({ driveId: DRIVE, issuer: ISSUER, orgId: COMCOM.id, role: "viewer", actor: "test" });
  });

  it("deleting the drive removes its organization shares", () => {
    const tmp = "d-gone";
    db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)").run(tmp, OWNER, "Gone", "h", "s");
    orgs.shareDriveWithOrg({ driveId: tmp, issuer: ISSUER, orgId: COMCOM.id, role: "viewer", actor: "test" });
    db.prepare("DELETE FROM drives WHERE id = ?").run(tmp);
    expect(db.prepare("SELECT COUNT(*) AS n FROM drive_org_shares WHERE drive_id = ?").get(tmp)).toEqual({ n: 0 });
  });
});

describe("home page data: organization sections", () => {
  it("lists each active organization with its drives; an org without drives is an empty section", () => {
    const sections = orgs.listOrgDrivesForUser(MEMBER);
    expect(sections.map((s) => s.name)).toEqual(["ComCom"]);
    expect(sections[0].drives.map((d) => d.id).sort()).toEqual([DRIVE, EDIT_DRIVE, PLAIN_DRIVE].sort());
    expect(orgs.listOrgDrivesForUser(OTHER)).toEqual([expect.objectContaining({ name: "Acme", drives: [] })]);
    expect(orgs.listOrgDrivesForUser(OUTSIDER)).toEqual([]);
    expect(orgs.listOrgDrivesForUser(SPLIT).map((s) => s.name)).toEqual(["Acme"]);
  });

  it("a share paused by its creator's suspension is reported as paused, not as 'no drive yet'", () => {
    const tmp = "d-acme-paused";
    const creator = "u-acme-creator";
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run(creator, `${creator}@example.com`, creator, "x");
    identity(creator, "acc_acme_creator"); membership(creator, "acc_acme_creator", ACME, "active", "admin");
    db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)").run(tmp, creator, "Acme HQ", "h", "s");
    orgs.shareDriveWithOrg({ driveId: tmp, issuer: ISSUER, orgId: ACME.id, role: "viewer", actor: "test" });
    expect(orgs.listOrgDrivesForUser(OTHER)).toEqual([expect.objectContaining({ name: "Acme", pausedDrives: 0, drives: [expect.objectContaining({ id: tmp })] })]);
    push("acc_acme_creator", ACME, "suspended", 2);
    expect(orgs.listOrgDrivesForUser(OTHER)).toEqual([expect.objectContaining({ name: "Acme", drives: [], pausedDrives: 1 })]);
    expect(access.resolveRoleByUser(tmp, OTHER, "")).toBe("none");
    push("acc_acme_creator", ACME, "active", 3, "admin");
    expect(orgs.listOrgDrivesForUser(OTHER)).toEqual([expect.objectContaining({ pausedDrives: 0, drives: [expect.objectContaining({ id: tmp })] })]);
    orgs.unshareDriveFromOrg({ driveId: tmp, orgId: ACME.id, actor: "test" });
  });
});
