// Account-grant sharing for third-party apps (AIN Mail): POST /api/oauth/drives/<id>/members
// (drives:share) and POST /api/oauth/drives/<id>/access-check (drives:read).
import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-oauth-share-"));
process.env.AINDRIVE_PUBLIC_URL = "http://drive.test";

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
const oauth = await import("../oauth");
const acct = await import("../account-tokens");
const { claimInvitesForEmail } = await import("../invites.js");
const { resolveRole } = await import("../access");
const grantRoute = await import("../../app/api/oauth/drives/[driveId]/members/route.js");
const checkRoute = await import("../../app/api/oauth/drives/[driveId]/access-check/route.js");
const { KNOWN_OAUTH_SCOPES } = await import("../oauth-trusted.js");

let clientId = "";
const ctx = (driveId = "d1") => ({ params: Promise.resolve({ driveId }) });
const post = (route: { POST: (r: Request, c: ReturnType<typeof ctx>) => Promise<Response> }, token: string, body: unknown, driveId = "d1") =>
  route.POST(new Request(`http://drive.test/api/oauth/drives/${driveId}/x`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }), ctx(driveId));
const token = (userId: string, scope: string) =>
  acct.issueAccountTokens({ userId, clientId, clientName: "AIN Mail", scopes: oauth.parseAccountScopes(scope) }).access_token;
const check = async (tok: string, path: string, emails: string[]) => {
  const res = await post(checkRoute, tok, { path, emails });
  return { status: res.status, body: await res.json() };
};

beforeAll(() => {
  const u = db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)");
  u.run("owner1", "o@example.com", "Owner", "x");
  u.run("coowner", "co@example.com", "Co", "x");
  u.run("editor1", "e@example.com", "Editor", "x");
  u.run("viewer1", "v@example.com", "Viewer", "x");
  u.run("bob", "bob@example.com", "Bob", "x");
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)").run("d1", "owner1", "D1", "h", "s");
  const m = db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)");
  m.run("m1", "d1", "coowner", "", "owner");
  m.run("m2", "d1", "editor1", "", "editor");
  m.run("m3", "d1", "viewer1", "docs", "viewer");
  clientId = oauth.registerClient("AIN Mail", ["http://localhost:3751/api/integrations/drive/callback"]).client_id;
});

describe("drives:share scope", () => {
  it("is a supported account scope and mirrored for trusted clients", () => {
    expect(oauth.ACCOUNT_SCOPES).toContain("drives:share");
    expect(oauth.authServerMetadata().scopes_supported).toContain("drives:share");
    expect([...KNOWN_OAUTH_SCOPES]).toEqual([...oauth.SCOPES_SUPPORTED]);
    expect(oauth.parseAccountScopes("profile drives:read drives:share")).toEqual(["profile", "drives:read", "drives:share"]);
  });
});

describe("POST /api/oauth/drives/<id>/members", () => {
  it("requires the drives:share scope", async () => {
    const res = await post(grantRoute, token("owner1", "profile drives:read drives:write"), { email: "bob@example.com", path: "", role: "viewer" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("insufficient_scope");
  });

  it("refuses a token without a bearer", async () => {
    const res = await grantRoute.POST(new Request("http://drive.test/x", { method: "POST", body: "{}" }), ctx());
    expect(res.status).toBe(401);
  });

  it("only owners may grant (an editor with drives:share is refused)", async () => {
    const res = await post(grantRoute, token("editor1", "drives:share"), { email: "bob@example.com", path: "", role: "viewer" });
    expect(res.status).toBe(403);
    expect(resolveRole("d1", "bob", "")).toBe("none");
  });

  it("never grants the owner role", async () => {
    const res = await post(grantRoute, token("owner1", "drives:share"), { email: "bob@example.com", path: "", role: "owner" });
    expect(res.status).toBe(400);
  });

  it("an owner grants viewer on a folder; the files under it inherit", async () => {
    const res = await post(grantRoute, token("owner1", "drives:share"), { email: "BOB@example.com", path: "/plans/", role: "viewer" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pending: false });
    expect(resolveRole("d1", "bob", "plans/q3.pdf")).toBe("viewer");
    expect(resolveRole("d1", "bob", "other.txt")).toBe("none");
  });

  it("a co-owner may grant editor; regranting never lowers a role", async () => {
    expect((await post(grantRoute, token("coowner", "drives:share"), { email: "bob@example.com", path: "plans", role: "editor" })).status).toBe(200);
    expect((await post(grantRoute, token("owner1", "drives:share"), { email: "bob@example.com", path: "plans", role: "viewer" })).status).toBe(200);
    expect(resolveRole("d1", "bob", "plans/x")).toBe("editor");
  });

  it("an unknown address becomes a pending invite that turns into access at signup", async () => {
    const res = await post(grantRoute, token("owner1", "drives:share"), { email: "new@example.com", path: "plans", role: "viewer" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, pending: true });
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("newbie", "new@example.com", "New", "x");
    expect(claimInvitesForEmail("newbie", "new@example.com")).toBe(1);
    expect(resolveRole("d1", "newbie", "plans/a.txt")).toBe("viewer");
  });

  it("rejects bad input and unknown drives", async () => {
    expect((await post(grantRoute, token("owner1", "drives:share"), { email: "nope", role: "viewer" })).status).toBe(400);
    expect((await post(grantRoute, token("owner1", "drives:share"), { email: "bob@example.com", role: "viewer" }, "missing")).status).toBe(404);
  });
});

describe("POST /api/oauth/drives/<id>/access-check", () => {
  it("drives:read alone is enough to check", async () => {
    const { status, body } = await check(token("owner1", "drives:read"), "", ["o@example.com", "co@example.com", "e@example.com", "v@example.com", "ghost@example.com"]);
    expect(status).toBe(200);
    expect(body.results).toEqual([
      { email: "o@example.com", access: "owner" },
      { email: "co@example.com", access: "owner" },
      { email: "e@example.com", access: "editor" },
      { email: "v@example.com", access: "none" }, // viewer only on docs/
      { email: "ghost@example.com", access: "none" }, // no account: indistinguishable from no access
    ]);
  });

  it("follows path inheritance and reports pending invites", async () => {
    await post(grantRoute, token("owner1", "drives:share"), { email: "later@example.com", path: "docs", role: "viewer" });
    const { body } = await check(token("owner1", "drives:read"), "docs/spec.md", ["v@example.com", "later@example.com", "bob@example.com"]);
    expect(body.results).toEqual([
      { email: "v@example.com", access: "viewer" },
      { email: "later@example.com", access: "pending" },
      { email: "bob@example.com", access: "none" },
    ]);
  });

  it("needs a drives:* read scope and at least viewer at the path", async () => {
    expect((await check(token("owner1", "drives:share"), "", ["o@example.com"])).status).toBe(403);
    expect((await check(token("viewer1", "drives:read"), "", ["o@example.com"])).status).toBe(403); // viewer only under docs/
    expect((await check(token("viewer1", "drives:read"), "docs", ["o@example.com"])).status).toBe(200);
    expect((await check(token("bob", "drives:read"), "", ["o@example.com"], )).status).toBe(403);
  });

  it("limits the batch size", async () => {
    const emails = Array.from({ length: 101 }, (_, i) => `u${i}@example.com`);
    expect((await check(token("owner1", "drives:read"), "", emails)).status).toBe(400);
  });
});
