// Change feed (ain-integration plan task 10, docs/10-change-propagation.md §1):
// lib/share-events-core.js + lib/share-events.ts, /api/me/events and
// /api/oauth/events, and the write paths that record into it.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import type { FileEvent } from "../share-events";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-share-events-"));
process.env.AINDRIVE_PUBLIC_URL = "https://drive.test";
// Organization shares are evaluated only with the AIN SSO adapter configured (lib/orgs.js).
const ISSUER = "https://auth.test";
process.env.AINDRIVE_SSO_ISSUER = ISSUER;
process.env.AINDRIVE_SSO_CLIENT_ID = "app_aindrive";
// A small retention window so the prune path runs without 10 000 rows.
process.env.AINDRIVE_SHARE_EVENT_RETENTION = "40";

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

const { db } = await import("../db.js");
const { sign } = await import("../session.js");
const { signPayload } = await import("../sig.js");
const ev = await import("../share-events");
const shared = await import("../shared-items");
const oauth = await import("../oauth");
const acct = await import("../account-tokens");
const agents = await import("../agents.js");
const membersRoute = await import("../../app/api/drives/[driveId]/members/route.js");
const memberRoute = await import("../../app/api/drives/[driveId]/members/[memberId]/route.js");
const leaveRoute = await import("../../app/api/drives/[driveId]/leave/route.js");
const driveRoute = await import("../../app/api/drives/[driveId]/route.js");
const acceptRoute = await import("../../app/api/s/[token]/accept/route.js");
const orgsRoute = await import("../../app/api/drives/[driveId]/orgs/route.js");
const orgRoute = await import("../../app/api/drives/[driveId]/orgs/[orgId]/route.js");
const meRoute = await import("../../app/api/me/events/route.js");
const oauthRoute = await import("../../app/api/oauth/events/route.js");

const ORIGIN = "https://drive.test";
const AGENT_TOKEN = "agent-token-for-d1";
const DRIVE_SECRET = "drive-secret-for-d1";
let clientId = "";
const issue = (userId: string, scope: string) =>
  acct.issueAccountTokens({ userId, clientId, clientName: "Afan", scopes: oauth.parseAccountScopes(scope) }).access_token;

const asUser = async (id: string) => cookieJar.set("aindrive_session", await sign(id));
const json = (body: unknown, method = "POST") => new Request(`${ORIGIN}/api`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const key = (driveId: string, path: string) => `${ORIGIN}#${driveId}#${shared.sharedFileId(driveId, path)}`;
const feed = (userId: string, cursor?: string) => ev.listShareEvents(userId, cursor).events as FileEvent[];
const meGet = (query = "") => meRoute.GET(new Request(`${ORIGIN}/api/me/events${query}`));
const tokenGet = (token: string | null, query = "") =>
  oauthRoute.GET(new Request(`${ORIGIN}/api/oauth/events${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }));

// A device socket: answers `stat` requests from `tree`, signed with the drive secret.
type FakeWs = EventEmitter & { OPEN: number; readyState: number; sent: string[]; _socket: EventEmitter; send(d: string): void; ping(): void; terminate(): void; close(): void };
function fakeAgent(tree: Record<string, { mtimeMs: number; size: number } | null>): FakeWs {
  const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, sent: [] as string[], _socket: new EventEmitter() }) as FakeWs;
  ws.ping = () => {};
  ws.terminate = () => { ws.readyState = 3; ws.emit("close"); };
  ws.close = () => { ws.readyState = 3; ws.emit("close"); };
  ws.send = (data: string) => {
    ws.sent.push(data);
    const frame = JSON.parse(data);
    if (frame.type !== "request" || frame.params?.method !== "stat") return;
    const e = tree[frame.params.path];
    const entry = e ? { name: frame.params.path.split("/").pop(), path: frame.params.path, isDir: false, ext: "txt", mime: "text/plain", ...e } : null;
    const body = { reqId: frame.reqId, ok: true, result: { method: "stat", entry } };
    const sig = signPayload(DRIVE_SECRET, body);
    setImmediate(() => ws.emit("message", Buffer.from(JSON.stringify({ type: "response", ...body, sig }))));
  };
  return ws;
}
const connect = (ws: FakeWs, driveId = "d1") =>
  agents.onAgentConnect(ws, { headers: { authorization: `Bearer ${AGENT_TOKEN}` } }, { driveId });
const settle = () => new Promise((r) => setTimeout(r, 30));
const openSockets: FakeWs[] = [];

beforeAll(async () => {
  const u = db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)");
  for (const id of ["owner1", "member1", "member2", "nobody1", "pruner1", "orgA", "orgB", "orgS"]) u.run(id, `${id}@example.com`, id, "x");
  // org_1: owner1 (admin — may share their drive with it), orgA and orgB active, orgS suspended.
  const ms = db.prepare(
    `INSERT INTO sso_memberships (issuer, org_id, subject, user_id, org_slug, org_name, status, app_role, groups_json, applied_version, updated_at)
     VALUES (?, 'org_1', ?, ?, 'one', 'Org One', ?, ?, '[]', 1, ?)`,
  );
  ms.run(ISSUER, "acc_owner", "owner1", "active", "admin", 1);
  ms.run(ISSUER, "acc_a", "orgA", "active", "member", 1);
  ms.run(ISSUER, "acc_b", "orgB", "active", "member", 1);
  ms.run(ISSUER, "acc_s", "orgS", "suspended", null, 1);
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)")
    .run("d1", "owner1", "Team", await bcrypt.hash(AGENT_TOKEN, 4), DRIVE_SECRET);
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)")
    .run("d2", "owner1", "Doomed", "h", "s");
  db.prepare("INSERT INTO shares (id, drive_id, path, role, token) VALUES (?,?,?,?,?)").run("s_free", "d1", "public", "viewer", "tok_free_link");
  clientId = oauth.registerClient("Afan", ["https://afan.example/cb"]).client_id;
});

afterAll(() => { for (const ws of openSockets) if (ws.readyState === 1) ws.close(); });

describe("resource keys", () => {
  it("are the shared-file list's key: <origin>#<driveId>#<p1 id>, path-normalised", () => {
    expect(ev.resourceKey("d1", "docs")).toBe(key("d1", "docs"));
    expect(ev.resourceKey("d1", "")).toBe(key("d1", "/"));
    expect(ev.resourceKey("d1", "앨범/파일.txt")).toBe(key("d1", "앨범/파일.txt"));
    expect(ev.resourceKey("d1", "./a//b/")).toBe(key("d1", "a/b"));
  });
});

describe("grants", () => {
  it("member added → file.shared to that member only", async () => {
    await asUser("owner1");
    const res = await membersRoute.POST(json({ email: "member1@example.com", path: "docs", role: "editor" }), ctx({ driveId: "d1" }));
    expect(res.status).toBe(200);
    const mine = feed("member1");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toEqual({
      kind: "file", type: "file.shared", eventId: expect.stringMatching(/^evt_\d+$/), resourceId: key("d1", "docs"),
      version: 1, occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/), recipient: "member1",
    });
    expect(feed("owner1")).toEqual([]);
    expect(feed("member2")).toEqual([]);
    expect(feed("nobody1")).toEqual([]);
  });

  it("member removed → file.revoked, and the version keeps climbing on that resource", async () => {
    await asUser("owner1");
    const row = db.prepare("SELECT id FROM drive_members WHERE drive_id='d1' AND user_id='member1' AND path='docs'").get() as { id: string };
    const res = await memberRoute.DELETE(new Request(`${ORIGIN}/api`, { method: "DELETE" }), ctx({ driveId: "d1", memberId: row.id }));
    expect(res.status).toBe(200);
    const mine = feed("member1");
    expect(mine.map((e) => [e.type, e.version])).toEqual([["file.shared", 1], ["file.revoked", 2]]);
    expect(mine[1].resourceId).toBe(key("d1", "docs"));
  });

  it("versions strictly increase per resource across recipients", async () => {
    await asUser("owner1");
    expect((await membersRoute.POST(json({ email: "member2@example.com", path: "docs", role: "viewer" }), ctx({ driveId: "d1" }))).status).toBe(200);
    expect((await membersRoute.POST(json({ email: "member1@example.com", path: "docs", role: "viewer" }), ctx({ driveId: "d1" }))).status).toBe(200);
    const m2 = feed("member2");
    expect(m2).toHaveLength(1);
    expect(m2[0].version).toBe(3);
    expect(feed("member1").map((e) => e.version)).toEqual([1, 2, 4]);
    const all = db.prepare("SELECT version FROM share_events WHERE resource_key = ? ORDER BY seq").all(key("d1", "docs")) as { version: number }[];
    expect(all.map((r) => r.version)).toEqual([1, 2, 3, 4]);
    // Another resource starts its own count.
    expect((await membersRoute.POST(json({ email: "member2@example.com", path: "other", role: "viewer" }), ctx({ driveId: "d1" }))).status).toBe(200);
    expect(feed("member2").at(-1)).toMatchObject({ resourceId: key("d1", "other"), version: 1 });
  });

  it("share-link accept → file.shared for the link's path; the event never carries the token", async () => {
    await asUser("member1");
    const res = await acceptRoute.POST(new Request(`${ORIGIN}/api`, { method: "POST" }), ctx({ token: "tok_free_link" }));
    expect(res.status).toBe(200);
    const last = feed("member1").at(-1)!;
    expect(last).toMatchObject({ type: "file.shared", resourceId: key("d1", "public"), version: 1 });
    expect(JSON.stringify(feed("member1"))).not.toMatch(/tok_free_link/);
  });

  it("leaving → file.revoked for every grant path held", async () => {
    await asUser("member1");
    const res = await leaveRoute.POST(new Request(`${ORIGIN}/api`, { method: "POST" }), ctx({ driveId: "d1" }));
    expect(res.status).toBe(200);
    const revoked = feed("member1").filter((e) => e.type === "file.revoked").map((e) => e.resourceId).sort();
    expect(revoked).toEqual([key("d1", "docs"), key("d1", "docs"), key("d1", "public")].sort());
    expect(feed("member1").at(-1)!.version).toBeGreaterThan(1);
  });

  it("drive deleted → file.deleted on the root key to the creator and every member, kept after the cascade", async () => {
    const m = db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)");
    m.run("dm1", "d2", "member1", "", "viewer");
    m.run("dm2", "d2", "member2", "x", "editor");
    m.run("dm3", "d2", "member2", "y", "editor");
    await asUser("owner1");
    const res = await driveRoute.DELETE(new Request(`${ORIGIN}/api`, { method: "DELETE" }), ctx({ driveId: "d2" }));
    expect(res.status).toBe(200);
    expect(db.prepare("SELECT count(*) AS n FROM drive_members WHERE drive_id='d2'").get()).toEqual({ n: 0 });
    for (const u of ["owner1", "member1", "member2"]) {
      const del = feed(u).filter((e) => e.type === "file.deleted");
      expect(del).toHaveLength(1);
      expect(del[0]).toMatchObject({ resourceId: key("d2", "/"), version: 1, recipient: u });
    }
    expect(feed("nobody1")).toEqual([]);
  });
});

describe("organization shares (R-SHARE-ORG-001)", () => {
  const mark: Record<string, number> = {};
  const since = (u: string) => feed(u).slice(mark[u] ?? 0).filter((e) => e.type === "file.shared" || e.type === "file.revoked");

  it("sharing a drive with an organization → file.shared on the root key to every active member, not the creator or a suspended member", async () => {
    for (const u of ["owner1", "member2", "orgA", "orgB", "orgS", "nobody1"]) mark[u] = feed(u).length;
    await asUser("owner1");
    const res = await orgsRoute.POST(json({ orgId: "org_1", role: "viewer" }), ctx({ driveId: "d1" }));
    expect(res.status).toBe(201);
    for (const u of ["orgA", "orgB"]) {
      expect(since(u)).toHaveLength(1);
      expect(since(u)[0]).toMatchObject({ type: "file.shared", resourceId: key("d1", "/"), recipient: u });
    }
    expect(since("orgA")[0].version).toBe(since("orgB")[0].version); // one change, one version
    for (const u of ["owner1", "member2", "orgS", "nobody1"]) expect(since(u)).toEqual([]);
    // The listed ref and the event name the same resource.
    expect(shared.listSharedItems("orgA", { scope: "shared_with_org" }).items.map((i) => `${ORIGIN}#${i.ref.driveId}#${i.ref.fileId}`)).toEqual([key("d1", "/")]);
  });

  it("a role change is not a new share, and a membership ending records nothing", async () => {
    await asUser("owner1");
    expect((await orgsRoute.POST(json({ orgId: "org_1", role: "editor" }), ctx({ driveId: "d1" }))).status).toBe(200);
    expect(since("orgA")).toHaveLength(1);
    expect(since("orgB")).toHaveLength(1);
    // orgB is suspended by the adapter: access ends on the next read; the feed stays quiet.
    db.prepare("UPDATE sso_memberships SET status = 'suspended', app_role = NULL WHERE issuer = ? AND org_id = 'org_1' AND user_id = 'orgB'").run(ISSUER);
    expect(since("orgB")).toHaveLength(1);
    expect(shared.listSharedItems("orgB", { scope: "shared_with_org" }).items).toEqual([]);
  });

  it("unsharing → file.revoked to the members active at that moment (the version keeps climbing)", async () => {
    await asUser("owner1");
    const res = await orgRoute.DELETE(new Request(`${ORIGIN}/api`, { method: "DELETE" }), ctx({ driveId: "d1", orgId: "org_1" }));
    expect(res.status).toBe(200);
    const a = since("orgA");
    expect(a.map((e) => e.type)).toEqual(["file.shared", "file.revoked"]);
    expect(a[1].resourceId).toBe(key("d1", "/"));
    expect(a[1].version).toBeGreaterThan(a[0].version);
    expect(since("orgB")).toHaveLength(1); // suspended before the unshare: no longer in the audience
    for (const u of ["owner1", "member2", "orgS", "nobody1"]) expect(since(u)).toEqual([]);
    expect(shared.listSharedItems("orgA", { scope: "shared_with_org" }).items).toEqual([]);
    // Nothing secret rode along.
    expect(JSON.stringify(feed("orgA"))).not.toMatch(/acc_|org_1|app_aindrive/);
  });
});

describe("device agent", () => {
  it("availability flips once per online/offline change, to the creator and members", async () => {
    const before = { owner1: feed("owner1").length, member2: feed("member2").length, nobody1: feed("nobody1").length };
    const avail = (u: string) => feed(u).slice(before[u as keyof typeof before]).filter((e) => e.type === "file.availability");
    const ws1 = fakeAgent({});
    const ws2 = fakeAgent({});
    openSockets.push(ws1, ws2);
    await connect(ws1);
    expect(agents.isAgentConnected("d1")).toBe(true);
    expect(avail("owner1")).toHaveLength(1);
    expect(avail("owner1")[0]).toMatchObject({ resourceId: key("d1", "/"), revision: "online", recipient: "owner1" });
    expect(avail("member2")).toHaveLength(1);
    expect(avail("nobody1")).toHaveLength(0);
    // A second device on an already-online drive is not a flip.
    await connect(ws2);
    expect(avail("owner1")).toHaveLength(1);
    // The primary (latest) socket closing takes the drive offline: one event.
    ws2.close();
    expect(agents.isAgentConnected("d1")).toBe(false);
    expect(avail("owner1").map((e) => e.revision)).toEqual(["online", "offline"]);
    expect(avail("member2").map((e) => e.revision)).toEqual(["online", "offline"]);
    // The stale socket closing later changes nothing.
    ws1.close();
    expect(avail("owner1")).toHaveLength(2);
    const versions = avail("owner1").map((e) => e.version);
    expect(versions[1]).toBeGreaterThan(versions[0]);
  });

  it("fs-changed → file.updated (with revision) when the path exists, file.deleted when it is gone; only grants touching the path hear it", async () => {
    const ws = fakeAgent({ "docs/a.txt": { mtimeMs: 1700000000000, size: 42 } });
    openSockets.push(ws);
    await connect(ws);
    const mark = { owner1: feed("owner1").length, member2: feed("member2").length };
    const since = (u: keyof typeof mark) => feed(u).slice(mark[u]).filter((e) => e.type === "file.updated" || e.type === "file.deleted");
    ws.emit("message", Buffer.from(JSON.stringify({ type: "fs-changed", path: "docs/a.txt" })));
    await settle();
    expect(since("owner1")).toEqual([expect.objectContaining({ type: "file.updated", resourceId: key("d1", "docs/a.txt"), revision: "m1700000000000-s42" })]);
    expect(since("member2")).toHaveLength(1); // grant on docs covers docs/a.txt
    ws.emit("message", Buffer.from(JSON.stringify({ type: "fs-changed", path: "docs/gone.txt" })));
    await settle();
    expect(since("owner1").at(-1)).toMatchObject({ type: "file.deleted", resourceId: key("d1", "docs/gone.txt") });
    expect(since("owner1").at(-1)!.revision).toBeUndefined();
    // A change outside every member grant reaches the creator only.
    ws.emit("message", Buffer.from(JSON.stringify({ type: "fs-changed", path: "private/z.txt" })));
    await settle();
    expect(since("owner1")).toHaveLength(3);
    expect(since("member2")).toHaveLength(2);
    ws.close();
  });
});

describe("paging and retention", () => {
  it("cursor paging: disjoint pages, then an empty page that echoes the cursor", () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    const total = feed("member1").length;
    expect(total).toBeGreaterThan(4);
    for (;;) {
      const page = ev.listShareEvents("member1", cursor, 3);
      expect(page.gap).toBe(false);
      expect(page.events.length).toBeLessThanOrEqual(3);
      if (page.events.length === 0) { expect(page.nextCursor).toBe(cursor); break; }
      for (const e of page.events) { expect(seen).not.toContain(e.eventId); seen.push(e.eventId); }
      expect(page.nextCursor).toBe(`ev_${page.events.at(-1)!.eventId.slice(4)}`);
      cursor = page.nextCursor;
      pages++;
    }
    expect(pages).toBe(Math.ceil(total / 3));
    expect(seen).toHaveLength(total);
    // Pages are oldest first and versions never go backwards on one resource.
    const byKey = new Map<string, number>();
    for (const e of feed("member1")) {
      expect(e.version).toBeGreaterThan(byKey.get(e.resourceId) ?? 0);
      byKey.set(e.resourceId, e.version);
    }
  });

  it("gap: a cursor ahead of anything the feed issued (restore / fresh install) re-lists from the floor", () => {
    const page = ev.listShareEvents("member1", "ev_999999");
    expect(page.gap).toBe(true);
    expect(page.nextCursor).not.toBe("ev_999999");
    expect(ev.decodeEventCursor(page.nextCursor)!).toBeLessThan(999999);
    // and the answer is the recipient's whole retained history, so a re-list can rebuild the cache
    const all = ev.listShareEvents("member1", null);
    expect(page.events.map((e) => e.eventId)).toEqual(all.events.map((e) => e.eventId));
  });

  it("gap: a malformed cursor, or one below the retention floor after a prune", () => {
    expect(ev.listShareEvents("member1", "garbage").gap).toBe(true);
    expect(ev.listShareEvents("member1", "ev_").gap).toBe(true);
    expect(ev.listShareEvents("member1", "ev_1x").gap).toBe(true);
    // Nothing pruned yet for member1: a cursor of 0 is fine.
    expect(ev.listShareEvents("member1", "ev_0").gap).toBe(false);

    expect(ev.RETENTION_PER_RECIPIENT).toBe(40);
    const n = ev.RETENTION_PER_RECIPIENT + 5;
    const first = db.prepare("SELECT coalesce(max(seq), 0) AS s FROM share_events").get() as { s: number };
    db.transaction(() => {
      for (let i = 0; i < n; i++) ev.recordShareEvent({ driveId: "d1", path: `bulk/${i % 7}.txt`, type: "file.updated", recipients: ["pruner1"] });
    })();
    const kept = db.prepare("SELECT count(*) AS n, min(seq) AS lo FROM share_events WHERE recipient_user_id = 'pruner1'").get() as { n: number; lo: number };
    expect(kept.n).toBe(ev.RETENTION_PER_RECIPIENT);
    const floor = kept.lo - 1;
    expect(floor).toBeGreaterThan(first.s);

    const stale = ev.listShareEvents("pruner1", `ev_${first.s}`, 2);
    expect(stale.gap).toBe(true);
    expect(stale.events[0].eventId).toBe(`evt_${kept.lo}`); // answers from the floor
    const none = ev.listShareEvents("pruner1");
    expect(none.gap).toBe(true);
    expect(ev.listShareEvents("pruner1", `ev_${floor}`).gap).toBe(false);
    expect(ev.listShareEvents("pruner1", `ev_${floor + 1}`).gap).toBe(false);
    expect(ev.listShareEvents("pruner1", `ev_${floor + 1}`).events).toHaveLength(ev.RETENTION_PER_RECIPIENT - 1);
    expect(ev.listShareEvents("pruner1", `ev_${floor}`, 500).events).toHaveLength(ev.RETENTION_PER_RECIPIENT);
    // Other recipients keep their own floor.
    expect(ev.listShareEvents("member1", "ev_0").gap).toBe(false);
  });
});

describe("GET /api/me/events (session)", () => {
  it("anonymous → 401 with the contract error body", async () => {
    cookieJar.clear();
    const res = await meGet();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "auth_required", message: expect.any(String), retryable: false, actionUrl: "https://drive.test/login" } });
  });

  it("a member gets a contract page with nothing secret in it", async () => {
    await asUser("member1");
    const res = await meGet();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(ev.parseEventPage(body)).not.toBeNull();
    expect(Object.keys(body).sort()).toEqual(["contract", "events", "gap", "nextCursor"]);
    expect(body.events.length).toBe(feed("member1").length);
    expect(body.events.every((e: { recipient: string }) => e.recipient === "member1")).toBe(true);
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); }
    };
    walk(body);
    expect(keys.filter((k) => /token|signature|secret|hash|sig$/i.test(k))).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/tok_free_link|agent-token|drive-secret/);
    const next = await (await meGet(`?cursor=${body.nextCursor}`)).json();
    expect(next).toEqual({ contract: "1.0", events: [], nextCursor: body.nextCursor, gap: false });
    expect((await (await meGet("?cursor=nope")).json()).gap).toBe(true);
    expect((await meGet(`?cursor=${"x".repeat(5000)}`)).status).toBe(415);
  });
});

describe("GET /api/oauth/events (account token)", () => {
  it("no / bad bearer → 401; profile-only → 403; drives:read → the same page as the session route, with CORS", async () => {
    const anon = await tokenGet(null);
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toMatch(/invalid_token/);
    expect(anon.headers.get("access-control-allow-origin")).toBe("*");
    expect((await anon.json()).error).toMatchObject({ code: "auth_required", retryable: false });
    expect((await tokenGet("aind_aat_nope")).status).toBe(401);
    const noScope = await tokenGet(issue("member1", "profile"));
    expect(noScope.status).toBe(403);
    expect((await noScope.json()).error).toMatchObject({ code: "forbidden", retryable: false });
    const ok = await tokenGet(issue("member1", "drives:read"));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");
    const body = await ok.json();
    expect(ev.parseEventPage(body)).not.toBeNull();
    expect(body.events.map((e: { eventId: string }) => e.eventId)).toEqual(feed("member1").map((e) => e.eventId));
    expect(oauthRoute.OPTIONS().status).toBe(204);
  });
});

describe("contract fixture", () => {
  it("the copied event-page.json parses against the local mirror", () => {
    const doc = JSON.parse(readFileSync(join(__dirname, "fixtures", "event-page.json"), "utf8"));
    const page = ev.parseEventPage(doc);
    expect(page).not.toBeNull();
    expect(page!.nextCursor).toBe("ev_3");
    expect(page!.events.map((e) => e.kind)).toEqual(["file", "file", "agent"]);
    expect(ev.decodeEventCursor(page!.nextCursor)).toBe(3);
    expect(ev.parseEventPage({ ...doc, gap: "no" })).toBeNull();
    expect(ev.parseEventPage({ ...doc, events: [{ ...doc.events[0], extra: 1 }] })).toBeNull();
  });
});
