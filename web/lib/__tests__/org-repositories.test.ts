// GET /api/orgs/:slug/repositories (app/api/orgs/[slug]/repositories/route.ts): the drive's
// `repositories/` folder for an organization slug, read by a viewer's session or by a trusted
// first-party application's AIN SSO machine token (ainize-node, for ainize.ai/<org>). The drive
// agent is a recording stub; the issuer an in-test key.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createTestIssuer, ISSUER, PUBLIC_URL } from "./sso-test-issuer";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-org-repos-"));
process.env.AINDRIVE_PUBLIC_URL = PUBLIC_URL;
process.env.AINDRIVE_SESSION_SECRET = "org-repos-test-secret-0123456789abcdef";
process.env.AINDRIVE_SSO_ISSUER = ISSUER;
process.env.AINDRIVE_SSO_CLIENT_ID = "app_aindrive";
process.env.AINDRIVE_SSO_SERVICE_APPS = "ainize";

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({
    get: (name: string) => { const v = cookieJar.get(name); return v === undefined ? undefined : { name, value: v }; },
    set: (name: string, value: string) => { cookieJar.set(name, value); },
    delete: (name: string) => { cookieJar.delete(name); },
  }),
}));

type Call = Record<string, unknown>;
const agent = { calls: [] as Call[] };
const entry = (name: string, isDir: boolean, mtimeMs: number) => ({ name, path: `repositories/${name}`, isDir, size: 0, mtimeMs, ext: "" });
vi.mock("../rpc", () => ({
  AgentError: class extends Error { status: number; constructor(m: string, s = 502) { super(m); this.status = s; } },
  isOnline: () => true,
  callAgent: async (_d: string, _s: string, req: Call) => {
    agent.calls.push(req);
    if (req.method === "list" && req.path === "repositories") {
      return { entries: [entry("clef-artwork-search", true, 2000), entry("clef-artwork-search.git", true, 1000), entry("notes", true, 3000), entry("README.md", false, 5), entry(".hidden", true, 1)] };
    }
    if (req.method === "list" && req.path === "repositories/clef-artwork-search") return { entries: [{ name: "ainize.json", path: "repositories/clef-artwork-search/ainize.json", isDir: false, size: 10, mtimeMs: 1, ext: "json" }] };
    if (req.method === "list") return { entries: [] };
    if (req.method === "git-meta") {
      if (req.repo === "repositories/clef-artwork-search") return { method: "git-meta", exists: true, branch: "main", head: { sha: "a".repeat(40), subject: "search by mood", author: "A", date: "2026-10-01" }, dirty: 0, commits: [] };
      return { method: "git-meta", exists: false };
    }
    return { ok: true };
  },
}));

const issuer = await createTestIssuer();
const { db } = await import("../db.js");
const orgs = await import("../orgs.js");
const { adapterJwksUrl, setJwksForTests } = await import("../sso/oidc");
const { sign } = await import("../session");
const route = await import("../../app/api/orgs/[slug]/repositories/route");

setJwksForTests(adapterJwksUrl(ISSUER), issuer.keys);
const COMCOM = { id: "org_comcom", slug: "comcom", name: "ComCom" };
const nowS = () => Math.floor(Date.now() / 1000);
function serviceToken(o: { orgs?: string[]; app?: string } = {}) {
  const app = o.app ?? "ainize";
  return issuer.sign({ iss: ISSUER, aud: PUBLIC_URL, sub: app, azp: app, client_id: app, jti: randomUUID(), orgs: o.orgs ?? [COMCOM.id] }, { typ: "at+jwt", exp: nowS() + 300 });
}
const get = (slug: string, init: RequestInit = {}) => route.GET(new Request(`${PUBLIC_URL}/api/orgs/${slug}/repositories`, init), { params: Promise.resolve({ slug }) });

beforeAll(() => {
  const u = db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)");
  u.run("owner1", "o@example.com", "Owner", "x");
  u.run("member1", "m@example.com", "Member", "x");
  u.run("stranger", "s@example.com", "Stranger", "x");
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)").run("d1", "owner1", "comcom", "h", "s");
  const m = db.prepare(
    `INSERT INTO sso_memberships (issuer, org_id, subject, user_id, org_slug, org_name, status, app_role, groups_json, applied_version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'member', '[]', 1, ?)`,
  );
  m.run(ISSUER, COMCOM.id, "acc_owner", "owner1", COMCOM.slug, COMCOM.name, "active", Date.now());
  m.run(ISSUER, COMCOM.id, "acc_member", "member1", COMCOM.slug, COMCOM.name, "active", Date.now());
  orgs.shareDriveWithOrg({ driveId: "d1", issuer: ISSUER, orgId: COMCOM.id, role: "viewer", actor: "operator", via: "operator" });
});
beforeEach(() => { agent.calls.length = 0; cookieJar.clear(); });

describe("GET /api/orgs/:slug/repositories", () => {
  it("lists the drive's repositories for a member, folding a bare sibling into its working copy, with HEAD and the manifest flag", async () => {
    cookieJar.set("aindrive_session", await sign("member1"));
    const res = await get("comcom");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.driveId).toBe("d1");
    expect(body.driveUrl).toBe(`${PUBLIC_URL}/d/d1?path=repositories`);
    expect(body.repositories.map((r: { name: string }) => r.name)).toEqual(["notes", "clef-artwork-search"]); // newest first; README.md and .hidden are not repos
    const clef = body.repositories[1];
    expect(clef).toEqual({ name: "clef-artwork-search", cloneUrl: `${PUBLIC_URL}/comcom/git/clef-artwork-search`, headSha: "a".repeat(40), headSubject: "search by mood", updatedAt: 2000, hasManifest: true });
    expect(body.repositories[0]).toMatchObject({ headSha: null, headSubject: null, hasManifest: false });
    expect(agent.calls.filter((c) => c.method === "git-meta").map((c) => c.repo).sort()).toEqual(["repositories/clef-artwork-search", "repositories/notes"]);
  });

  it("is read by ainize's machine token as itself, and refused to an app the org share does not cover", async () => {
    const ok = await get("comcom", { headers: { authorization: `Bearer ${await serviceToken()}` } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).repositories.length).toBe(2);
    const other = await get("comcom", { headers: { authorization: `Bearer ${await serviceToken({ orgs: ["org_other"] })}` } });
    expect(other.status).toBe(403);
  });

  it("refuses anonymous callers and strangers, and hides whether an unknown slug exists", async () => {
    expect((await get("comcom")).status).toBe(401);
    cookieJar.set("aindrive_session", await sign("stranger"));
    expect((await get("comcom")).status).toBe(403);
    const none = await get("nobody");
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({ error: "not found" });
    expect((await get("api")).status).toBe(404);
  });
});
