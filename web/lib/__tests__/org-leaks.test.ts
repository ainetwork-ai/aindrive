// Organization access must stay LIVE (docs/PERMISSIONS.md "Organizations"):
// nothing reached through an organization may be written down as a durable
// grant, and every way the access ends must reach open sockets too. These are
// the review's leak scenarios, run through the real routes, the real
// provisioning adapter (signed PUTs) and the real operator script.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CLIENT_ID, ISSUER, PUBLIC_URL, cookieJar, createTestIssuer } from "./sso-test-issuer";
import type { DesiredUserState } from "../sso/store.js";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-org-leaks-"));
process.env.AINDRIVE_SESSION_SECRET = "org-leaks-test-secret-0123456789abcdef0";
process.env.AINDRIVE_PUBLIC_URL = PUBLIC_URL;
process.env.AINDRIVE_SSO_ISSUER = ISSUER;
process.env.AINDRIVE_SSO_CLIENT_ID = CLIENT_ID;
process.env.AINDRIVE_DEV_BYPASS_X402 = "1";

const { jar, cookies } = cookieJar();
vi.mock("next/headers", () => ({ cookies }));
vi.mock("../rpc", () => ({
  AgentError: class extends Error { status = 502; },
  isOnline: () => true,
  callAgent: async (_d: string, _s: string, req: { method: string; path: string }) => {
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
const { handleAdapterUser } = await import("../sso/adapter");
const { onDocConnect, revalidateOrgPeers } = await import("../dochub.js");
const sharesRoute = await import("../../app/api/drives/[driveId]/shares/route.js");
const shareRoute = await import("../../app/api/s/[token]/route.js");
const acceptRoute = await import("../../app/api/s/[token]/accept/route.js");
const orgRoute = await import("../../app/api/drives/[driveId]/orgs/[orgId]/route.js");
const fsList = await import("../../app/api/drives/[driveId]/fs/list/route.js");
const showcaseList = await import("../../app/api/drives/[driveId]/showcase/route.js");
const showcaseItem = await import("../../app/api/drives/[driveId]/showcase/[shareId]/route.js");

const issuer = await createTestIssuer();
const COMCOM = { id: "org_comcom", slug: "comcom", name: "ComCom" };
const ACME = { id: "org_acme", slug: "acme", name: "Acme" };

const OWNER = "u-owner";           // ComCom admin; owns TEAM (editor share) and HQ (viewer share)
const ACME_ADMIN = "u-acme-admin"; // Acme admin; owns ACME_DRIVE (editor share with Acme)
const PERSONAL = "u-personal";     // an unrelated personal account (e.g. an employee's own)
const LEGACY = "u-legacy";         // a legacy account AIN SSO (wrongly) maps a subject to
const INVITED = "u-invited";       // personal editor of TEAM, invited by the owner

const TEAM = "d-team";
const HQ = "d-hq";
const ACME_DRIVE = "d-acme";

const url = (p: string) => `${PUBLIC_URL}${p}`;
const ctx = (driveId: string) => ({ params: Promise.resolve({ driveId }) });
const tctx = (token: string) => ({ params: Promise.resolve({ token }) });
async function as(userId: string | null) {
  jar.clear();
  if (userId) jar.set("aindrive_session", await sign(userId));
}
const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url(p), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

function desired(sub: string, org: typeof COMCOM, over: Partial<DesiredUserState> = {}): DesiredUserState {
  return {
    schema: "ain-sso.adapter.v1", sub, org, version: 1, status: "active",
    profile: { name: null, email: null, workEmail: null },
    appRole: "member", groups: [], legacyUserId: null, ownershipTransferTo: null, issuedAt: new Date().toISOString(),
    ...over,
  } as DesiredUserState;
}
/** The real provisioning adapter path (verify → apply → close sockets → re-check org drives). */
async function put(s: DesiredUserState) {
  const body = JSON.stringify(s);
  const u = url(`/api/sso/v1/orgs/${encodeURIComponent(s.org.id)}/users/${encodeURIComponent(s.sub)}`);
  const token = await issuer.adapterToken({ method: "PUT", url: u, body });
  const res = await handleAdapterUser(new Request(u, { method: "PUT", body, headers: { "content-type": "application/json", authorization: `Bearer ${token}` } }), s.org.id, s.sub, { keys: issuer.keys });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { localUserId: string };
}

type FakeWs = { closedWith: number | null; sent: string[]; readyState: number; OPEN: number; handlers: Record<string, (d: unknown) => void>; close(code: number): void; send(s: string): void; on(ev: string, fn: (d: unknown) => void): void };
const fakeWs = (): FakeWs => ({
  closedWith: null, sent: [], readyState: 1, OPEN: 1, handlers: {},
  close(code) { this.closedWith = code; this.readyState = 3; this.handlers.close?.(undefined); },
  send(s) { this.sent.push(s); },
  on(ev, fn) { this.handlers[ev] = fn; },
});
async function connect(userId: string, driveId: string, path = "handbook.md") {
  const ws = fakeWs();
  await onDocConnect(ws, { headers: { cookie: `aindrive_session=${await sign(userId)}` } }, { drive: driveId, path });
  return ws;
}
const frames = (ws: FakeWs, t: string) => ws.sent.filter((s) => JSON.parse(s).t === t).length;

function newDrive(id: string, owner = OWNER) {
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)").run(id, owner, id, "h", "s");
}
function memberRows(driveId: string, userId: string) {
  return db.prepare("SELECT path, role FROM drive_members WHERE drive_id = ? AND user_id = ?").all(driveId, userId);
}
async function mint(userId: string, driveId: string, body: Record<string, unknown>) {
  await as(userId);
  return sharesRoute.POST(post(`/api/drives/${driveId}/shares`, body), ctx(driveId));
}
async function listLinks(userId: string, driveId: string) {
  await as(userId);
  const res = await sharesRoute.GET(new Request(url(`/api/drives/${driveId}/shares`)), ctx(driveId));
  return { status: res.status, shares: res.status === 200 ? ((await res.json()).shares as { id: string; role: string; token: string; price_usdc: number | null }[]) : [] };
}

let ED = "", MULTI = "", DEP = "", MEM = "";

beforeAll(async () => {
  const u = db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)");
  for (const id of [OWNER, ACME_ADMIN, PERSONAL, LEGACY, INVITED]) u.run(id, `${id}@example.com`, id, "x");
  await put(desired("acc_owner", COMCOM, { appRole: "admin", legacyUserId: OWNER }));
  await put(desired("acc_acme_admin", ACME, { appRole: "admin", legacyUserId: ACME_ADMIN }));
  ED = (await put(desired("acc_ed", COMCOM))).localUserId;
  MULTI = (await put(desired("acc_multi", COMCOM))).localUserId;
  await put(desired("acc_multi", ACME));
  DEP = (await put(desired("acc_dep", COMCOM))).localUserId;
  MEM = (await put(desired("acc_kim", COMCOM))).localUserId;

  newDrive(TEAM);
  newDrive(HQ);
  newDrive(ACME_DRIVE, ACME_ADMIN);
  orgs.shareDriveWithOrg({ driveId: TEAM, issuer: ISSUER, orgId: COMCOM.id, role: "editor", actor: "operator" });
  orgs.shareDriveWithOrg({ driveId: HQ, issuer: ISSUER, orgId: COMCOM.id, role: "viewer", actor: "operator" });
  orgs.shareDriveWithOrg({ driveId: ACME_DRIVE, issuer: ISSUER, orgId: ACME.id, role: "editor", actor: "operator" });
  db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)").run("m-inv", TEAM, INVITED, "", "editor");
});

describe("an organization's role is never turned into a durable grant through share links", () => {
  it("an org editor can't mint a link (either role) — the owner and personal editors still can", async () => {
    const viewer = await mint(ED, TEAM, { path: "", role: "viewer" });
    expect(viewer.status).toBe(403);
    expect((await viewer.json()).error).toMatch(/organization/);
    expect((await mint(ED, TEAM, { path: "docs", role: "viewer" })).status).toBe(403);
    expect((await mint(ED, TEAM, { path: "", role: "editor" })).status).toBe(403);
    expect((await mint(INVITED, TEAM, { path: "", role: "viewer" })).status).toBe(200);
    expect((await mint(OWNER, TEAM, { path: "", role: "editor" })).status).toBe(200);
    expect(access.resolveRoleByUser(TEAM, ED, "")).toBe("editor"); // still edits the drive itself
  });

  it("so nothing survives the creator unsharing the drive", async () => {
    const tmp = "d-l1";
    newDrive(tmp);
    orgs.shareDriveWithOrg({ driveId: tmp, issuer: ISSUER, orgId: COMCOM.id, role: "editor", actor: "operator" });
    expect((await mint(ED, tmp, { path: "", role: "viewer" })).status).toBe(403);
    await as(OWNER);
    const del = await orgRoute.DELETE(new Request(url(`/api/drives/${tmp}/orgs/${COMCOM.id}`), { method: "DELETE" }), { params: Promise.resolve({ driveId: tmp, orgId: COMCOM.id }) });
    expect(del.status).toBe(200);
    expect(access.resolveRoleByUser(tmp, ED, "")).toBe("none");
    expect(memberRows(tmp, ED)).toEqual([]);
  });

  it("…nor a suspension in that organization while the account stays active elsewhere", async () => {
    expect((await mint(MULTI, TEAM, { path: "", role: "viewer" })).status).toBe(403);
    await put(desired("acc_multi", COMCOM, { version: 2, status: "suspended", appRole: null }));
    await as(MULTI); // a new session: the account is still active through Acme
    expect((await fsList.GET(new Request(url(`/api/drives/${TEAM}/fs/list?path=`)), ctx(TEAM))).status).toBe(403);
  });

  it("…nor a deprovisioned editor's link redeemed from another account (there is no such link)", async () => {
    const r = await mint(DEP, TEAM, { path: "", role: "viewer" });
    expect(r.status).toBe(403);
    await put(desired("acc_dep", COMCOM, { version: 2, status: "deprovisioned", appRole: null }));
    expect(access.resolveRoleByUser(TEAM, DEP, "")).toBe("none");
  });

  it("GET /shares: an org editor sees no one else's free or editor link, only paid viewer links (badges)", async () => {
    const tmp = "d-l1b";
    newDrive(tmp);
    orgs.shareDriveWithOrg({ driveId: tmp, issuer: ISSUER, orgId: COMCOM.id, role: "editor", actor: "operator" });
    db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)").run("m-inv-b", tmp, INVITED, "", "editor");
    const ins = db.prepare("INSERT INTO shares (id, drive_id, path, role, token, created_by, price_usdc, currency) VALUES (?,?,?,?,?,?,?,?)");
    ins.run("s-own-ed", tmp, "", "editor", "tok-own-ed", OWNER, null, null);
    ins.run("s-own-free", tmp, "", "viewer", "tok-own-free", OWNER, null, null);
    ins.run("s-own-paid", tmp, "premium", "viewer", "tok-own-paid", OWNER, 1, "USDC");
    ins.run("s-own-paid-ed", tmp, "premium", "editor", "tok-own-paid-ed", OWNER, 5, "USDC");
    ins.run("s-inv-free", tmp, "", "viewer", "tok-inv-free", INVITED, null, null);

    const org = await listLinks(ED, tmp);
    expect(org.status).toBe(200);
    expect(org.shares.map((s) => s.id).sort()).toEqual(["s-own-paid"]);
    // A personal editor: their own link + the paid viewer link.
    expect((await listLinks(INVITED, tmp)).shares.map((s) => s.id).sort()).toEqual(["s-inv-free", "s-own-paid"]);
    // The owner's ledger is complete.
    expect((await listLinks(OWNER, tmp)).shares).toHaveLength(5);
    // A viewer (org or not) still can't list.
    expect((await listLinks(MEM, HQ)).status).toBe(403);

    // The owner's editor link, if an org editor got hold of it anyway, is the
    // owner's grant to whoever holds it (link semantics) — not reachable
    // through GET /shares any more.
    orgs.unshareDriveFromOrg({ driveId: tmp, orgId: COMCOM.id, actor: "operator" });
    expect(access.resolveRoleByUser(tmp, ED, "")).toBe("none");
  });

  it("accepting a paid link the org already covers lets the member in without writing a member row", async () => {
    const tmp = "d-paid";
    newDrive(tmp);
    orgs.shareDriveWithOrg({ driveId: tmp, issuer: ISSUER, orgId: COMCOM.id, role: "editor", actor: "operator" });
    db.prepare("INSERT INTO shares (id, drive_id, path, role, token, created_by, price_usdc, currency) VALUES (?,?,?,?,?,?,?,?)")
      .run("s-paid-ed", tmp, "premium", "editor", "tok-paid-ed", OWNER, 5, "USDC");
    await as(ED);
    // GET /s: entitled right now (through the organization) → the gate calls accept.
    const g = await shareRoute.GET(new Request(url("/api/s/tok-paid-ed")), tctx("tok-paid-ed"));
    expect(g.status).toBe(200);
    const a = await acceptRoute.POST(post("/api/s/tok-paid-ed/accept", {}), tctx("tok-paid-ed"));
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ driveId: tmp, path: "premium" });
    expect(memberRows(tmp, ED)).toEqual([]);
    orgs.unshareDriveFromOrg({ driveId: tmp, orgId: COMCOM.id, actor: "operator" });
    expect(access.resolveRoleByUser(tmp, ED, "premium/a.md")).toBe("none");
    // Not covered any more → pay.
    expect((await acceptRoute.POST(post("/api/s/tok-paid-ed/accept", {}), tctx("tok-paid-ed"))).status).toBe(402);
  });

  it("a paid purchase by an org member records what was bought, never the organization's role", async () => {
    const tmp = "d-buy";
    newDrive(tmp);
    orgs.shareDriveWithOrg({ driveId: tmp, issuer: ISSUER, orgId: COMCOM.id, role: "viewer", actor: "operator" });
    db.prepare("INSERT INTO shares (id, drive_id, path, role, token, created_by, price_usdc, currency) VALUES (?,?,?,?,?,?,?,?)")
      .run("s-buy", tmp, "premium", "viewer", "tok-buy", OWNER, 1, "USDC");
    await as(MEM);
    // An org viewer is a bare viewer: the paid carve-out applies → 402, then pays.
    expect((await shareRoute.GET(new Request(url("/api/s/tok-buy")), tctx("tok-buy"))).status).toBe(402);
    const pay = Buffer.from(JSON.stringify({ payload: { authorization: { from: "0x" + "a".repeat(40) } } })).toString("base64");
    const paid = await shareRoute.GET(new Request(url("/api/s/tok-buy"), { headers: { "PAYMENT-SIGNATURE": pay } }), tctx("tok-buy"));
    expect(paid.status).toBe(200);
    expect(memberRows(tmp, MEM)).toEqual([{ path: "premium", role: "viewer" }]);
    orgs.unshareDriveFromOrg({ driveId: tmp, orgId: COMCOM.id, actor: "operator" });
    expect(access.resolveRoleByUser(tmp, MEM, "")).toBe("none");
    expect(access.resolveRoleByUser(tmp, MEM, "premium/a.md")).toBe("viewer"); // what they paid for
  });
});

describe("operator script (another process) → open doc sockets", () => {
  function script(...args: string[]) {
    const r = spawnSync(process.execPath, ["scripts/org-drive.mjs", ...args], { cwd: join(__dirname, "../.."), env: process.env, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  }

  it("`share --role viewer` on an editor share: the member's next edit is dropped and its socket closes", async () => {
    const tmp = "d-l2";
    newDrive(tmp);
    orgs.shareDriveWithOrg({ driveId: tmp, issuer: ISSUER, orgId: COMCOM.id, role: "editor", actor: "operator" });
    const stale = await connect(MEM, tmp);
    const peer = await connect(OWNER, tmp);
    expect(JSON.parse(stale.sent[0]).role).toBe("editor");
    expect((globalThis as { __aindrive_dochub_org_sweep?: unknown }).__aindrive_dochub_org_sweep).toBeTruthy();
    script("share", "--drive", tmp, "--org", "comcom", "--role", "viewer");
    expect(access.resolveRoleByUser(tmp, MEM, "")).toBe("viewer"); // HTTP sees it at once
    stale.handlers.message?.(Buffer.from(JSON.stringify({ t: "sync", msg: "AAAA" })));
    expect({ closed: stale.closedWith, pushed: frames(peer, "sync") }).toEqual({ closed: 4401, pushed: 0 });
    expect(peer.closedWith).toBeNull();
  });

  it("`unshare`: a passive reader is closed by the re-check sweep", async () => {
    const tmp = "d-l2b";
    newDrive(tmp);
    orgs.shareDriveWithOrg({ driveId: tmp, issuer: ISSUER, orgId: COMCOM.id, role: "viewer", actor: "operator" });
    const reader = await connect(MEM, tmp);
    const owner = await connect(OWNER, tmp);
    expect(JSON.parse(reader.sent[0]).role).toBe("viewer");
    script("unshare", "--drive", tmp, "--org", "comcom");
    expect(reader.closedWith).toBeNull(); // this process was not told…
    expect(revalidateOrgPeers().closed).toBeGreaterThanOrEqual(1); // …the sweep finds it
    expect(reader.closedWith).toBe(4401);
    expect(owner.closedWith).toBeNull(); // personal access is not swept
  });
});

describe("a rolled-back legacy mapping", () => {
  it("closes the legacy account's sockets on the subject's OTHER organizations' drives too", async () => {
    await put(desired("acc_l", COMCOM, { legacyUserId: LEGACY }));
    await put(desired("acc_l", ACME, { legacyUserId: LEGACY }));
    // LEGACY's own sessions (nobody signed in through AIN) reach the org drives.
    expect(access.resolveRoleByUser(ACME_DRIVE, LEGACY, "")).toBe("editor");
    const ws = await connect(LEGACY, ACME_DRIVE);
    expect(JSON.parse(ws.sent[0]).role).toBe("editor");
    await put(desired("acc_l", COMCOM, { version: 2, legacyUserId: null }));
    expect(access.resolveRoleByUser(ACME_DRIVE, LEGACY, "")).toBe("none");
    expect(ws.closedWith).toBe(4401);
    // The unlinked account can't mint anything from what it had either.
    expect(memberRows(ACME_DRIVE, LEGACY)).toEqual([]);
  });
});

describe("showcase: one relationship gate for the list and the Buy click-through", () => {
  it("an org-only member lists the showcase and reaches the paywall; an outsider gets 403 on both", async () => {
    db.prepare("INSERT INTO shares (id, drive_id, path, role, token, created_by, price_usdc, currency, listed) VALUES (?,?,?,?,?,?,?,?,1)")
      .run("sh-paid", HQ, "premium", "viewer", "tok-paid", OWNER, 1, "USDC");
    const item = () => showcaseItem.GET(new Request(url(`/api/drives/${HQ}/showcase/sh-paid`)), { params: Promise.resolve({ driveId: HQ, shareId: "sh-paid" }) });
    await as(MEM);
    expect((await showcaseList.GET(new Request(url(`/api/drives/${HQ}/showcase`)), ctx(HQ))).status).toBe(200);
    const buy = await item();
    expect(buy.status).toBe(303);
    expect(buy.headers.get("location")).toBe("/s/tok-paid");
    await as(PERSONAL);
    expect((await showcaseList.GET(new Request(url(`/api/drives/${HQ}/showcase`)), ctx(HQ))).status).toBe(403);
    expect((await item()).status).toBe(403);
    expect(access.isRelatedToDrive(HQ, MEM)).toBe(true);
    expect(access.isRelatedToDrive(HQ, PERSONAL)).toBe(false);
  });
});
