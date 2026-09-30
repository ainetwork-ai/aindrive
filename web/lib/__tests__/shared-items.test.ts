// R-SHARE-LIST-002 (docs/PERMISSIONS_MATRIX.md §4): the common shared-file list
// in the cross-product contract shape — lib/shared-items.ts, /api/me/shared,
// /api/oauth/shared and the list_shared skill.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { FileListItem, FileListResponse, FileListScope, ListSharedOpts } from "../shared-items";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-shared-items-"));
process.env.AINDRIVE_PUBLIC_URL = "https://drive.test";
process.env.AINDRIVE_SSO_ISSUER = "https://auth.test";
process.env.AINDRIVE_SSO_CLIENT_ID = "app_aindrive"; // organization access is evaluated (lib/orgs.js orgAccessIssuer)

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

// Agent liveness is an in-memory registry; drive the "online" answer directly.
const online = new Set<string>();
vi.mock("../rpc", () => ({
  isOnline: (driveId: string) => online.has(driveId),
  callAgent: () => { throw new Error("no agent in this test"); },
  AgentError: class extends Error {},
}));

const { db } = await import("../db.js");
const { sign } = await import("../session.js");
const shared = await import("../shared-items");
const oauth = await import("../oauth");
const acct = await import("../account-tokens");
const meRoute = await import("../../app/api/me/shared/route.js");
const oauthRoute = await import("../../app/api/oauth/shared/route.js");
const { runSkill, driveScopedDescriptors, SKILL_DESCRIPTORS } = await import("../../shared/agent-skills");

const ORIGIN = "https://drive.test";
let clientId = "";
const issue = (userId: string, scope: string) =>
  acct.issueAccountTokens({ userId, clientId, clientName: "Afan", scopes: oauth.parseAccountScopes(scope) }).access_token;

const meGet = (query: string) => meRoute.GET(new Request(`${ORIGIN}/api/me/shared?${query}`));
const tokenGet = (query: string, token: string | null) =>
  oauthRoute.GET(new Request(`${ORIGIN}/api/oauth/shared?${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }));

const list = (userId: string, scope: FileListScope, extra: Partial<ListSharedOpts> = {}) =>
  shared.listSharedItems(userId, { scope, ...extra });
const paths = (r: FileListResponse) => r.items.map((i) => `${i.ref.driveId}:${i.ref.legacy?.path}`).sort();

const NFD_PATH = "앨범/파일.txt"; // 앨범/파일.txt as jamo
const NFC_PATH = "앨범/파일.txt";

beforeAll(async () => {
  const u = db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)");
  for (const [id, email] of [["owner1", "o@example.com"], ["member1", "m@example.com"], ["buyer1", "b@example.com"], ["nobody1", "n@example.com"], ["invitee1", "i@example.com"], ["pager1", "p@example.com"], ["orgmember1", "om@example.com"], ["suspended1", "su@example.com"]]) {
    u.run(id, email, id, "x");
  }
  const d = db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret, last_seen_at, created_at) VALUES (?,?,?,?,?,?,?)");
  d.run("d1", "owner1", "Team Drive", "h", "s", "2026-09-28 10:00:00", "2026-09-01 00:00:00");
  d.run("d2", "owner1", "Second", "h", "s", null, "2026-09-02 00:00:00");
  d.run("d3", "member1", "Members Own", "h", "s", null, "2026-09-03 00:00:00");
  const m = db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role, created_at) VALUES (?,?,?,?,?,?)");
  m.run("m1", "d1", "member1", "", "viewer", "2026-09-10 00:00:00");
  m.run("m2", "d1", "member1", "docs", "editor", "2026-09-11 00:00:00");
  m.run("m3", "d1", "member1", "premium", "viewer", "2026-09-12 00:00:00"); // priced, not bought
  m.run("m4", "d1", "buyer1", "premium", "viewer", "2026-09-13 00:00:00"); // priced, bought
  m.run("m5", "d1", "member1", NFD_PATH, "viewer", "2026-09-14 00:00:00");
  // A member row on a drive the same account created must never count as "shared with me".
  m.run("m6", "d3", "member1", "", "editor", "2026-09-14 00:00:00");
  const s = db.prepare("INSERT INTO shares (id, drive_id, path, role, token, price_usdc, currency, listed) VALUES (?,?,?,?,?,?,?,?)");
  s.run("s_paid", "d1", "premium", "viewer", "tok_paid", 5, "USDC", 1);
  s.run("s_secret", "d1", "secret", "viewer", "tok_secret", 3, "USDC", 0); // unlisted, nobody granted
  db.prepare("INSERT INTO payment_receipts (id, drive_id, path, wallet, tx_hash, amount_usdc, currency, network, share_id, account_id) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("r1", "d1", "premium", "0xabc", "0xtx1", 5, "USDC", "base", "s_paid", "buyer1");
  db.prepare("INSERT INTO drive_invites (id, drive_id, email, path, role) VALUES (?,?,?,?,?)").run("inv1", "d1", "i@example.com", "", "viewer");
  db.prepare("INSERT INTO sso_identities (issuer, subject, user_id, link_method, linked_at) VALUES (?,?,?,?,?)")
    .run("https://auth.test", "acc_owner", "owner1", "jit", Date.now());
  for (const p of ["a", "b", "c", "d", "e"]) m.run(`pg_${p}`, "d2", "pager1", p, "viewer", `2026-09-2${p.charCodeAt(0) - 96} 00:00:00`);
  // Organizations (R-SHARE-ORG-001): owner1 is active in org_1 and org_2 and
  // shares d1 with org_1 (viewer) and d2 with org_2 (editor). orgmember1 is
  // active in both; suspended1 holds a suspended org_1 row; member1/nobody1
  // are in none. d3 is shared with org_1 by member1, who is NOT a member of
  // it: that share is paused (R-ORG-ACC-003) and must not be listed.
  const ms = db.prepare(
    `INSERT INTO sso_memberships (issuer, org_id, subject, user_id, org_slug, org_name, status, app_role, groups_json, applied_version, updated_at)
     VALUES ('https://auth.test', ?, ?, ?, ?, ?, ?, ?, '[]', 1, ?)`,
  );
  ms.run("org_1", "acc_owner", "owner1", "one", "Org One", "active", "admin", 1);
  ms.run("org_2", "acc_owner", "owner1", "two", "Org Two", "active", "admin", 1);
  ms.run("org_1", "acc_om", "orgmember1", "one", "Org One", "active", "member", 1);
  ms.run("org_2", "acc_om", "orgmember1", "two", "Org Two", "active", "member", 1);
  ms.run("org_1", "acc_su", "suspended1", "one", "Org One", "suspended", null, 1);
  const os = db.prepare("INSERT INTO drive_org_shares (drive_id, issuer, org_id, role, created_by, created_at, updated_at) VALUES (?,'https://auth.test',?,?,?,?,?)");
  os.run("d1", "org_1", "viewer", "owner1", Date.UTC(2026, 8, 15), Date.UTC(2026, 8, 15));
  os.run("d2", "org_2", "editor", "owner1", Date.UTC(2026, 8, 16), Date.UTC(2026, 8, 16));
  os.run("d3", "org_1", "editor", "member1", Date.UTC(2026, 8, 17), Date.UTC(2026, 8, 17));
  clientId = oauth.registerClient("Afan", ["https://afan.example/cb"]).client_id;
});

describe("listSharedItems — scopes", () => {
  it("mine: the owner sees each created drive as a root folder ref, and never under shared_with_me", () => {
    const mine = list("owner1", "mine");
    expect(mine.contract).toBe("1.0");
    expect(mine.nextCursor).toBeNull();
    expect(paths(mine)).toEqual(["d1:/", "d2:/"]);
    const d1 = mine.items.find((i) => i.ref.driveId === "d1")!;
    expect(d1).toMatchObject({ role: "owner", shareOrigin: "own" });
    expect(d1.ref).toMatchObject({
      issuer: ORIGIN, kind: "folder", displayName: "Team Drive",
      fileId: shared.sharedFileId("d1", ""), revision: "m1790589600000-s0",
      ownerRef: { kind: "account", issuer: "https://auth.test", subject: "acc_owner" },
      sourceUrl: "https://drive.test/d/d1/", legacy: { path: "/" },
    });
    expect(list("owner1", "shared_with_me").items).toEqual([]);
  });

  it("shared_with_me: a member sees the drive at each grant path with the role there; their own drive is excluded", () => {
    const r = list("member1", "shared_with_me");
    expect(paths(r)).toEqual(["d1:/", "d1:/docs", "d1:/premium", `d1:/${NFC_PATH}`]);
    const root = r.items.find((i) => i.ref.legacy?.path === "/")!;
    expect(root).toMatchObject({ role: "viewer", shareOrigin: "direct", sharedAt: "2026-09-10T00:00:00.000Z" });
    expect(root.ref.displayName).toBe("Team Drive");
    expect(root.paid).toBeUndefined();
    const docs = r.items.find((i) => i.ref.legacy?.path === "/docs")!;
    expect(docs).toMatchObject({ role: "editor", shareOrigin: "direct" });
    expect(docs.ref).toMatchObject({ kind: "folder", displayName: "docs", sourceUrl: "https://drive.test/d/d1/docs" });
    // A file share is told from a folder by its extension.
    const file = r.items.find((i) => i.ref.legacy?.path === `/${NFC_PATH}`)!;
    expect(file.ref).toMatchObject({ kind: "file", mimeType: "text/plain", displayName: "파일.txt" });
    // Owner of d3 → d3 only under mine, never shared_with_me even with a member row.
    expect(paths(list("member1", "mine"))).toEqual(["d3:/"]);
    // Newest grant first (recent's stand-in order).
    expect(r.items[0].ref.legacy?.path).toBe(`/${NFC_PATH}`);
  });

  it("a non-member sees nothing; a pending invite is not shared yet", () => {
    expect(list("nobody1", "mine").items).toEqual([]);
    expect(list("nobody1", "shared_with_me").items).toEqual([]);
    expect(list("invitee1", "shared_with_me").items).toEqual([]);
    expect(list("invitee1", "recent").items).toEqual([]);
  });

  it("paid: a receipt at the grant path → shareOrigin paid + entitled; an unpaid priced grant → entitled false", () => {
    const buyer = list("buyer1", "shared_with_me");
    expect(buyer.items).toHaveLength(1);
    expect(buyer.items[0]).toMatchObject({ role: "viewer", shareOrigin: "paid", paid: { entitled: true, pricingRef: "share:s_paid" } });
    const member = list("member1", "shared_with_me").items.find((i) => i.ref.legacy?.path === "/premium")!;
    expect(member).toMatchObject({ shareOrigin: "direct", paid: { entitled: false, pricingRef: "share:s_paid" } });
    // An owner without an SSO link is named by this server's account id.
    expect(list("buyer1", "shared_with_me").items[0].ref.ownerRef).toEqual({ kind: "account", issuer: "https://auth.test", subject: "acc_owner" });
    expect(list("member1", "shared_with_me").items.every((i) => i.ref.ownerRef.subject === "acc_owner")).toBe(true);
    const d3 = list("member1", "mine").items[0];
    expect(d3.ref.ownerRef).toEqual({ kind: "account", issuer: ORIGIN, subject: "member1" });
  });

  it("an unlisted sale nobody was granted never surfaces (R-VIS-PAID-001/002)", () => {
    for (const u of ["member1", "buyer1", "nobody1", "invitee1"]) {
      const all = [...list(u, "shared_with_me").items, ...list(u, "mine").items];
      expect(all.some((i) => i.ref.legacy?.path === "/secret")).toBe(false);
    }
  });

  it("availability follows the agent registry; lastSeenAt from drives.last_seen_at", () => {
    const off = list("member1", "shared_with_me").items[0].ref.availability;
    expect(off).toEqual({ state: "offline", lastSeenAt: "2026-09-28T10:00:00.000Z" });
    online.add("d1");
    try {
      expect(list("member1", "shared_with_me").items[0].ref.availability.state).toBe("online");
    } finally {
      online.delete("d1");
    }
    // Never seen: no lastSeenAt at all.
    expect(list("owner1", "mine").items.find((i) => i.ref.driveId === "d2")!.ref.availability).toEqual({ state: "offline" });
  });

  it("shared_with_org: an active member sees each drive shared with their organizations as a root ref with the share's role (R-SHARE-ORG-001)", () => {
    const r = list("orgmember1", "shared_with_org");
    expect(r.nextCursor).toBeNull();
    // Newest share first; d3's share is paused (its creator is not in org_1) and never listed.
    expect(r.items.map((i) => i.ref.driveId)).toEqual(["d2", "d1"]);
    const d1 = r.items[1];
    expect(d1).toMatchObject({ role: "viewer", shareOrigin: "org", sharedAt: "2026-09-15T00:00:00.000Z" });
    expect(d1.paid).toBeUndefined();
    expect(d1.ref).toMatchObject({
      issuer: ORIGIN, kind: "folder", displayName: "Team Drive", fileId: shared.sharedFileId("d1", ""),
      ownerRef: { kind: "account", issuer: "https://auth.test", subject: "acc_owner" },
      availability: { state: "offline", lastSeenAt: "2026-09-28T10:00:00.000Z" },
      sourceUrl: "https://drive.test/d/d1/", legacy: { path: "/" },
    });
    expect(r.items[0]).toMatchObject({ role: "editor", shareOrigin: "org", ref: { driveId: "d2", displayName: "Second", legacy: { path: "/" } } });
    // Availability follows the agent registry, as for any ref.
    online.add("d1");
    try {
      expect(list("orgmember1", "shared_with_org").items[1].ref.availability.state).toBe("online");
    } finally {
      online.delete("d1");
    }
    // Only the organization scope carries these rows; nothing secret rides along.
    expect(list("orgmember1", "shared_with_me").items).toEqual([]);
    expect(list("orgmember1", "mine").items).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/drive_secret|agent_token_hash|namespace_/);
  });

  it("shared_with_org: the caller's own drives, a non-member, a member of no organization and a suspended member get nothing", () => {
    expect(list("owner1", "shared_with_org").items).toEqual([]); // owner1 is a member of both orgs — but they are their drives
    expect(list("member1", "shared_with_org").items).toEqual([]); // in no organization (a direct grant on d1 is shared_with_me)
    expect(list("nobody1", "shared_with_org").items).toEqual([]);
    expect(list("suspended1", "shared_with_org").items).toEqual([]);
    // A suspended row wins over an active one for the same (org, account).
    db.prepare("INSERT INTO sso_memberships (issuer, org_id, subject, user_id, status, groups_json, applied_version, updated_at) VALUES ('https://auth.test','org_1','acc_su2','suspended1','active','[]',1,2)").run();
    try {
      expect(list("suspended1", "shared_with_org").items).toEqual([]);
    } finally {
      db.prepare("DELETE FROM sso_memberships WHERE subject = 'acc_su2'").run();
    }
  });

  it("org= keeps one organization's rows; outside shared_with_org it is unsupported (empty + header)", () => {
    expect(list("orgmember1", "shared_with_org", { org: "org_1" }).items.map((i) => i.ref.driveId)).toEqual(["d1"]);
    expect(list("orgmember1", "shared_with_org", { org: "org_2" }).items.map((i) => i.ref.driveId)).toEqual(["d2"]);
    expect(list("orgmember1", "shared_with_org", { org: "org_none" }).items).toEqual([]);
    expect(list("suspended1", "shared_with_org", { org: "org_1" }).items).toEqual([]);
    expect(list("member1", "shared_with_me", { org: "org_1" }).items).toEqual([]);
    expect(shared.sharedScopeHeaders("shared_with_org")).toEqual({});
    expect(shared.sharedScopeHeaders("shared_with_org", "org_1")).toEqual({});
    expect(shared.sharedScopeHeaders("shared_with_me", "org_1")).toEqual({ "X-AIN-Scope-Unsupported": "org" });
    expect(shared.sharedScopeHeaders("recent")).toEqual({ "X-AIN-Scope-Fallback": "recent=shared_with_me" });
  });

  it("recent falls back to shared_with_me", () => {
    expect(paths(list("member1", "recent"))).toEqual(paths(list("member1", "shared_with_me")));
  });

  it("q filters by name or path, case-insensitively", () => {
    expect(paths(list("member1", "shared_with_me", { q: "DOC" }))).toEqual(["d1:/docs"]);
    expect(paths(list("member1", "shared_with_me", { q: "team" }))).toEqual(["d1:/"]);
    expect(list("member1", "shared_with_me", { q: "zzz" }).items).toEqual([]);
  });
});

describe("fileId — phase A path-derived id", () => {
  const p1 = (driveId: string, cpath: string) => "p1:" + createHash("sha256").update(`${driveId}\0${cpath}`).digest("hex").slice(0, 32);

  it("equals the p1 formula and is stable across NFD/NFC, slashes and '.' segments", () => {
    expect(shared.sharedFileId("d1", NFC_PATH)).toBe(p1("d1", `/${NFC_PATH}`));
    expect(shared.sharedFileId("d1", NFD_PATH)).toBe(shared.sharedFileId("d1", NFC_PATH));
    expect(shared.sharedFileId("d1", `./${NFC_PATH}`)).toBe(shared.sharedFileId("d1", `/${NFC_PATH}/`));
    expect(shared.sharedFileId("d1", "a\\b")).toBe(shared.sharedFileId("d1", "a/b"));
    expect(shared.sharedFileId("d1", "")).toBe(p1("d1", "/"));
    // Case is identity (R-ACC-PATH-001), and the drive is part of the id.
    expect(shared.sharedFileId("d1", "A")).not.toBe(shared.sharedFileId("d1", "a"));
    expect(shared.sharedFileId("d2", "a")).not.toBe(shared.sharedFileId("d1", "a"));
    expect(shared.sharedFileId("d1", "a")).toMatch(/^p1:[0-9a-f]{32}$/);
  });

  it("the listed NFD grant carries the NFC id and path", () => {
    const item = list("member1", "shared_with_me").items.find((i) => i.ref.displayName === "파일.txt")!;
    expect(item.ref.fileId).toBe(p1("d1", `/${NFC_PATH}`));
    expect(item.ref.legacy?.path.normalize("NFC")).toBe(item.ref.legacy?.path);
  });
});

describe("cursor pagination", () => {
  it("returns disjoint pages that together cover every row, then a null cursor", () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = list("pager1", "shared_with_me", { limit: 2, cursor });
      expect(page.cursorExpired).toBeUndefined();
      expect(page.items.length).toBeLessThanOrEqual(2);
      for (const i of page.items) {
        expect(seen).not.toContain(i.ref.fileId);
        seen.push(i.ref.fileId);
      }
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen.sort()).toEqual(["a", "b", "c", "d", "e"].map((p) => shared.sharedFileId("d2", p)).sort());
  });

  it("a cursor from another scope or garbage restarts from the first page with cursorExpired", () => {
    const first = list("pager1", "shared_with_me", { limit: 2 });
    const foreign = list("pager1", "mine", { limit: 2, cursor: first.nextCursor! });
    expect(foreign.cursorExpired).toBe(true);
    const garbage = list("pager1", "shared_with_me", { limit: 2, cursor: "not-a-cursor" });
    expect(garbage.cursorExpired).toBe(true);
    expect(garbage.items.map((i) => i.ref.fileId)).toEqual(first.items.map((i) => i.ref.fileId));
  });
});

describe("GET /api/me/shared (session)", () => {
  it("anonymous → 401 with the contract error body", async () => {
    cookieJar.clear();
    const res = await meGet("scope=shared_with_me");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: { code: "auth_required", message: expect.any(String), retryable: false, actionUrl: "https://drive.test/login" } });
  });

  it("a member gets the contract page, flagged headers for approximated scopes, and nothing secret", async () => {
    cookieJar.set("aindrive_session", await sign("member1"));
    const res = await meGet("scope=shared_with_me&limit=10");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.contract).toBe("1.0");
    expect(body.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.items).toHaveLength(4);
    expect(Object.keys(body).sort()).toEqual(["asOf", "contract", "items", "nextCursor"]);
    expect(Object.keys(body.items[0]).sort()).toEqual(["ref", "role", "shareOrigin", "sharedAt"]);
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); }
    };
    walk(body);
    expect(keys.filter((k) => /token|signature|secret|hash|sig$/i.test(k))).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/tok_paid|tok_secret/);

    const org = await meGet("scope=shared_with_org");
    expect(org.headers.get("x-ain-scope-unsupported")).toBeNull();
    expect((await org.json()).items).toEqual([]); // member1 is in no organization
    cookieJar.set("aindrive_session", await sign("orgmember1"));
    const orgRows = await (await meGet("scope=shared_with_org&org=org_1")).json();
    expect(orgRows.items.map((i: FileListItem) => [i.ref.driveId, i.shareOrigin])).toEqual([["d1", "org"]]);
    expect((await meGet("scope=shared_with_me&org=org_1")).headers.get("x-ain-scope-unsupported")).toBe("org");
    cookieJar.set("aindrive_session", await sign("member1"));
    const recent = await meGet("scope=recent");
    expect(recent.headers.get("x-ain-scope-fallback")).toBe("recent=shared_with_me");
    expect((await recent.json()).items).toHaveLength(4);
  });

  it("defaults to shared_with_me and rejects a bad query with unsupported_input", async () => {
    cookieJar.set("aindrive_session", await sign("buyer1"));
    expect((await (await meGet("")).json()).items).toHaveLength(1);
    const bad = await meGet("scope=everything");
    expect(bad.status).toBe(415);
    expect((await bad.json()).error).toMatchObject({ code: "unsupported_input", retryable: false });
    expect((await meGet("limit=0")).status).toBe(415);
    expect((await meGet("limit=201")).status).toBe(415);
  });
});

describe("GET /api/oauth/shared (account token)", () => {
  it("no / bad bearer → 401 contract body with WWW-Authenticate; profile-only → 403 forbidden", async () => {
    const anon = await tokenGet("scope=mine", null);
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toMatch(/invalid_token/);
    expect(anon.headers.get("access-control-allow-origin")).toBe("*");
    expect((await anon.json()).error).toMatchObject({ code: "auth_required", retryable: false });
    expect((await tokenGet("scope=mine", "aind_aat_nope")).status).toBe(401);
    const noScope = await tokenGet("scope=mine", issue("owner1", "profile"));
    expect(noScope.status).toBe(403);
    expect(noScope.headers.get("www-authenticate")).toMatch(/insufficient_scope/);
    expect((await noScope.json()).error).toMatchObject({ code: "forbidden", retryable: false });
  });

  it("drives:read lists the same rows as the session route, with CORS and the scope headers", async () => {
    const res = await tokenGet("scope=shared_with_me", issue("member1", "drives:read"));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-expose-headers")).toMatch(/X-AIN-Scope-Unsupported/);
    const body = await res.json();
    expect(body.items.map((i: FileListItem) => i.ref.fileId).sort())
      .toEqual(list("member1", "shared_with_me").items.map((i) => i.ref.fileId).sort());
    const mine = await (await tokenGet("scope=mine", issue("owner1", "drives:read"))).json();
    expect(mine.items.map((i: FileListItem) => i.ref.driveId).sort()).toEqual(["d1", "d2"]);
    const org = await tokenGet("scope=shared_with_org", issue("orgmember1", "drives:read"));
    expect(org.headers.get("x-ain-scope-unsupported")).toBeNull();
    expect((await org.json()).items.map((i: FileListItem) => i.ref.driveId)).toEqual(["d2", "d1"]);
    expect(oauthRoute.OPTIONS().status).toBe(204);
  });

  it("rate limit → 429 rate_limited with Retry-After", async () => {
    const token = issue("owner1", "drives:read");
    const headers = { authorization: `Bearer ${token}`, "x-forwarded-for": "10.9.9.9" };
    let last: Response | null = null;
    for (let i = 0; i < 121; i++) last = await oauthRoute.GET(new Request(`${ORIGIN}/api/oauth/shared?scope=mine`, { headers }));
    expect(last!.status).toBe(429);
    expect(last!.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await last!.json()).error).toMatchObject({ code: "rate_limited", retryable: true, retryAfterSeconds: expect.any(Number) });
  });
});

describe("skill list_shared", () => {
  it("is offered on the account surface, not on a drive-pinned one", () => {
    expect(SKILL_DESCRIPTORS.map((d) => d.name)).toContain("list_shared");
    expect(driveScopedDescriptors("write").map((d) => d.name)).not.toContain("list_shared");
  });

  it("returns the contract page for the account; forbidden when pinned to a drive; validates args", async () => {
    const ok = await runSkill({ userId: "member1" }, "list_shared", { scope: "shared_with_me", limit: 2 });
    expect(ok.kind).toBe("ok");
    if (ok.kind !== "ok") return;
    const page = ok.structured as FileListResponse;
    expect(page.contract).toBe("1.0");
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeTruthy();
    expect(ok.text).toMatch(/Team Drive|docs|파일\.txt/);
    const next = await runSkill({ userId: "member1" }, "list_shared", { scope: "shared_with_me", limit: 2, cursor: page.nextCursor });
    expect(next.kind === "ok" && (next.structured as FileListResponse).items.map((i) => i.ref.fileId))
      .not.toEqual(page.items.map((i) => i.ref.fileId));
    const dflt = await runSkill({ userId: "buyer1" }, "list_shared", {});
    expect(dflt.kind === "ok" && (dflt.structured as FileListResponse).items[0].shareOrigin).toBe("paid");
    expect(await runSkill({ userId: "member1", driveId: "d1" }, "list_shared", {})).toMatchObject({ kind: "err", code: "forbidden" });
    expect(await runSkill({ userId: "member1" }, "list_shared", { scope: "public" })).toMatchObject({ kind: "err", code: "invalid_params" });
    expect(await runSkill({ userId: "member1" }, "list_shared", { limit: 0 })).toMatchObject({ kind: "err", code: "invalid_params" });
  });
});
