// Service principals (lib/sso/service-principal.ts): a first-party AIN application —
// ainize-node cloning a project's repo — reading an org-shared drive as ITSELF with an
// AIN SSO client_credentials JWT, through the real gate (lib/require-access.ts) and the
// real git smart-HTTP front (lib/git-http.ts, both URL shapes) and git-meta, with the
// drive agent replaced by a recording stub and the issuer by an in-test key.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createTestIssuer, ISSUER, PUBLIC_URL } from "./sso-test-issuer";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-service-principal-"));
process.env.AINDRIVE_PUBLIC_URL = PUBLIC_URL;
process.env.AINDRIVE_SESSION_SECRET = "service-principal-test-secret-0123456789";
process.env.AINDRIVE_SSO_ISSUER = ISSUER;
process.env.AINDRIVE_SSO_CLIENT_ID = "app_aindrive";
process.env.AINDRIVE_SSO_SERVICE_APPS = "ainize, ainteams";

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
const PACK = Buffer.from("0008NAK\n0000");
vi.mock("../rpc", () => ({
  AgentError: class extends Error { status: number; constructor(m: string, s = 502) { super(m); this.status = s; } },
  isOnline: () => true,
  callAgent: async (_d: string, _s: string, req: Call) => {
    agent.calls.push(req);
    switch (req.method) {
      case "git-advertise": return { method: "git-advertise", exists: true, data: Buffer.from("003f0123456789abcdef0123456789abcdef01234567 refs/heads/main\n0000").toString("base64") };
      case "git-service": return { method: "git-service", size: PACK.length };
      case "download-chunk": return { method: "download-chunk", data: PACK.toString("base64"), eof: true };
      case "git-meta": return { method: "git-meta", exists: true, branch: "main", head: null, dirty: 0, commits: [] };
      case "list": return { entries: [] };
      case "read": throw new Error("no manifest");
    }
    return { ok: true };
  },
}));

const issuer = await createTestIssuer();
const { db } = await import("../db.js");
const orgs = await import("../orgs.js");
const { adapterJwksUrl, setJwksForTests } = await import("../sso/oidc");
const sp = await import("../sso/service-principal");
const idRoute = await import("../../app/api/drives/[driveId]/git/[...path]/route");
const slugRoute = await import("../../app/[slug]/git/[...path]/route");
const metaRoute = await import("../../app/api/drives/[driveId]/git-meta/route");

setJwksForTests(adapterJwksUrl(ISSUER), issuer.keys);

const COMCOM = { id: "org_comcom", slug: "comcom", name: "ComCom" };
const OTHER = { id: "org_other", slug: "other", name: "Other" };
const nowS = () => Math.floor(Date.now() / 1000);

/** An AIN SSO machine token as the issuer mints it (architecture §4.9). */
function serviceToken(o: { app?: string; aud?: string; orgs?: string[]; iat?: number; exp?: number; typ?: string; key?: "k1" | "other"; azp?: string | null; sub?: string } = {}) {
  const app = o.app ?? "ainize";
  const payload: Record<string, unknown> = { iss: ISSUER, aud: o.aud ?? PUBLIC_URL, sub: o.sub ?? app, client_id: app, jti: randomUUID(), orgs: o.orgs ?? [COMCOM.id] };
  if (o.azp !== null) payload.azp = o.azp ?? app;
  return issuer.sign(payload, { typ: o.typ ?? "at+jwt", key: o.key, iat: o.iat, exp: o.exp ?? (o.iat ?? nowS()) + 300 });
}

const auth = (token: string, extra: Record<string, string> = {}) => ({ headers: { authorization: `Bearer ${token}`, ...extra } });
const refs = (base: string) => `${base}/info/refs?service=git-upload-pack`;
const pushRefs = (base: string) => `${base}/info/refs?service=git-receive-pack`;
const ID_REPO = `${PUBLIC_URL}/api/drives/d1/git/site`;
const SLUG_REPO = `${PUBLIC_URL}/comcom/git/site`;
const idCtx = (path: string[]) => ({ params: Promise.resolve({ driveId: "d1", path }) });
const slugCtx = (slug: string, path: string[]) => ({ params: Promise.resolve({ slug, path }) });

beforeAll(() => {
  const u = db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)");
  u.run("owner1", "o@example.com", "Owner", "x");
  u.run("owner2", "o2@example.com", "Owner Two", "x");
  u.run("gone", "g@example.com", "Gone", "x");
  const d = db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)");
  d.run("d1", "owner1", "comcom", "h", "s");     // shared with comcom (in force); named like the org so /comcom/git/… resolves to it among two shared drives (lib/git-slug.ts)
  d.run("d2", "owner2", "Private", "h", "s");    // nobody's org
  d.run("d3", "owner1", "OtherOrg", "h", "s");   // shared with another org
  d.run("d4", "gone", "Lapsed", "h", "s");       // shared with comcom, but the creator was suspended
  const m = db.prepare(
    `INSERT INTO sso_memberships (issuer, org_id, subject, user_id, org_slug, org_name, status, app_role, groups_json, applied_version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'member', '[]', 1, ?)`,
  );
  m.run(ISSUER, COMCOM.id, "acc_1", "owner1", COMCOM.slug, COMCOM.name, "active", Date.now());
  m.run(ISSUER, OTHER.id, "acc_1", "owner1", OTHER.slug, OTHER.name, "active", Date.now());
  m.run(ISSUER, COMCOM.id, "acc_gone", "gone", COMCOM.slug, COMCOM.name, "suspended", Date.now());
  const share = (driveId: string, org: typeof COMCOM) => orgs.shareDriveWithOrg({ driveId, issuer: ISSUER, orgId: org.id, role: "viewer", actor: "operator", via: "operator" });
  share("d1", COMCOM); share("d3", OTHER); share("d4", COMCOM);
});
beforeEach(() => { agent.calls.length = 0; cookieJar.clear(); });

describe("the token", () => {
  it("is recognised by shape and verified against the issuer, the audience and the trust list", async () => {
    expect(sp.isServiceToken(await serviceToken())).toBe(true);
    expect(sp.isServiceToken("aind_aat_not_a_jwt")).toBe(false);
    expect(sp.isServiceToken(await serviceToken({ typ: "ain-rdlg+jwt" }))).toBe(false);
    const ok = await sp.verifyServiceToken(await serviceToken({ orgs: [COMCOM.id, OTHER.id] }));
    expect(ok).toMatchObject({ ok: true, principal: { clientId: "ainize", orgs: [COMCOM.id, OTHER.id] } });
    expect(await sp.verifyServiceToken(await serviceToken({ aud: "https://elsewhere.example.test" }))).toMatchObject({ ok: false, reason: "claim:aud" });
    expect(await sp.verifyServiceToken(await serviceToken({ app: "stranger" }))).toMatchObject({ ok: false, reason: "untrusted_app" });
    expect(await sp.verifyServiceToken(await serviceToken({ iat: nowS() - 1000, exp: nowS() - 600 }))).toMatchObject({ ok: false, reason: "expired" });
    expect(await sp.verifyServiceToken(await serviceToken({ key: "other" }))).toMatchObject({ ok: false });
    expect(await sp.verifyServiceToken(await serviceToken({ azp: "ainteams" }))).toMatchObject({ ok: false, reason: "not_a_service_token" }); // sub and azp disagree
    expect(await sp.verifyServiceToken(await serviceToken({ sub: "acc_person", azp: "ainize" }))).toMatchObject({ ok: false, reason: "not_a_service_token" }); // a user token with a client_id
    const token = await serviceToken({ azp: null }); // azp optional: client_id carries it
    expect(await sp.verifyServiceToken(token)).toMatchObject({ ok: true });
  });

  it("gives viewer only where an in-force org share names one of its organizations", async () => {
    const p = { clientId: "ainize", orgs: [COMCOM.id], jti: null, exp: null };
    expect(sp.serviceRoleInDrive("d1", p)).toBe("viewer");
    expect(sp.serviceRoleInDrive("d2", p)).toBe("none");
    expect(sp.serviceRoleInDrive("d3", p)).toBe("none");
    expect(sp.serviceRoleInDrive("d4", p)).toBe("none"); // the creator is no longer active
    expect(sp.serviceRoleInDrive("d3", { ...p, orgs: [OTHER.id] })).toBe("viewer");
    expect(sp.serviceRoleInDrive("d1", { ...p, orgs: [] })).toBe("none");
  });
});

describe("git smart-HTTP", () => {
  it("clones with a valid token over the drive-id URL: refs advertised, pack served", async () => {
    const token = await serviceToken();
    const adv = await idRoute.GET(new Request(refs(ID_REPO), auth(token)), idCtx(["site", "info", "refs"]));
    expect(adv.status).toBe(200);
    expect(adv.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    // the id URL names the working copy `site`; git's transport runs on the bare sibling (lib/git-paths.ts)
    expect(agent.calls[0]).toMatchObject({ method: "git-advertise", repo: "site.git", service: "upload-pack" });
    const pack = await idRoute.POST(new Request(`${ID_REPO}/git-upload-pack`, { method: "POST", body: "0032want 0123456789abcdef0123456789abcdef01234567\n0000", ...auth(token, { "content-type": "application/x-git-upload-pack-request" }) }), idCtx(["site", "git-upload-pack"]));
    expect(pack.status).toBe(200);
    expect(Buffer.from(await pack.arrayBuffer()).equals(PACK)).toBe(true);
    expect(agent.calls.map((c) => c.method)).toContain("git-service");
  });

  it("clones over the friendly /<org>/git/<repo> URL too", async () => {
    const res = await slugRoute.GET(new Request(refs(SLUG_REPO), auth(await serviceToken())), slugCtx("comcom", ["site", "info", "refs"]));
    expect(res.status).toBe(200);
    // /<org>/git/<name> is the working copy repositories/<name>, transport on repositories/<name>.git
    expect(agent.calls[0]).toMatchObject({ method: "git-advertise", repo: "repositories/site.git" });
  });

  it("also takes the token as the HTTP Basic password a plain git client sends", async () => {
    const basic = Buffer.from(`x-access-token:${await serviceToken()}`).toString("base64");
    const res = await idRoute.GET(new Request(refs(ID_REPO), { headers: { authorization: `Basic ${basic}` } }), idCtx(["site", "info", "refs"]));
    expect(res.status).toBe(200);
  });

  it("refuses a wrong audience, an unknown application and an expired token with 401, touching no agent", async () => {
    for (const bad of [
      await serviceToken({ aud: "https://elsewhere.example.test" }),
      await serviceToken({ app: "stranger" }),
      await serviceToken({ iat: nowS() - 1000, exp: nowS() - 600 }),
      await serviceToken({ key: "other" }),
    ]) {
      const res = await idRoute.GET(new Request(refs(ID_REPO), auth(bad)), idCtx(["site", "info", "refs"]));
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("invalid_token");
      expect((await res.json()).error).toBe("invalid service token");
    }
    expect(agent.calls).toEqual([]);
  });

  it("refuses a push (receive-pack) with 403, on both URL shapes", async () => {
    const token = await serviceToken();
    const a = await idRoute.GET(new Request(pushRefs(ID_REPO), auth(token)), idCtx(["site", "info", "refs"]));
    expect(a.status).toBe(403);
    const b = await idRoute.POST(new Request(`${ID_REPO}/git-receive-pack`, { method: "POST", body: "0000", ...auth(token) }), idCtx(["site", "git-receive-pack"]));
    expect(b.status).toBe(403);
    const c = await slugRoute.POST(new Request(`${SLUG_REPO}/git-receive-pack`, { method: "POST", body: "0000", ...auth(token) }), slugCtx("comcom", ["site", "git-receive-pack"]));
    expect(c.status).toBe(403);
    expect(agent.calls).toEqual([]); // never even git-init
  });

  it("refuses drives outside its organizations with 403: unshared, another org's, a lapsed share", async () => {
    for (const driveId of ["d2", "d3", "d4"]) {
      const res = await idRoute.GET(new Request(refs(`${PUBLIC_URL}/api/drives/${driveId}/git/site`), auth(await serviceToken())), { params: Promise.resolve({ driveId, path: ["site", "info", "refs"] }) });
      expect(res.status, driveId).toBe(403);
    }
    const none = await idRoute.GET(new Request(refs(ID_REPO), auth(await serviceToken({ orgs: [] }))), idCtx(["site", "info", "refs"]));
    expect(none.status).toBe(403);
    expect(agent.calls).toEqual([]);
  });

  it("never reaches the reserved subtree, and a missing drive is 404", async () => {
    const token = await serviceToken();
    const reserved = await idRoute.GET(new Request(refs(`${PUBLIC_URL}/api/drives/d1/git/.aindrive/x`), auth(token)), idCtx([".aindrive", "x", "info", "refs"]));
    expect(reserved.status).toBe(403);
    const missing = await idRoute.GET(new Request(refs(`${PUBLIC_URL}/api/drives/nope/git/site`), auth(token)), { params: Promise.resolve({ driveId: "nope", path: ["site", "info", "refs"] }) });
    expect(missing.status).toBe(404);
  });

  it("is off without AINDRIVE_SSO_SERVICE_APPS: the same token is a 401", async () => {
    const saved = process.env.AINDRIVE_SSO_SERVICE_APPS;
    process.env.AINDRIVE_SSO_SERVICE_APPS = "";
    try {
      const res = await idRoute.GET(new Request(refs(ID_REPO), auth(await serviceToken())), idCtx(["site", "info", "refs"]));
      expect(res.status).toBe(401);
      expect((await res.json()).reason).toBe("no_service_apps");
    } finally { process.env.AINDRIVE_SSO_SERVICE_APPS = saved; }
  });
});

describe("git-meta", () => {
  it("answers the agent's summary to a service principal, and 401/403 like the git routes", async () => {
    const ok = await metaRoute.GET(new Request(`${PUBLIC_URL}/api/drives/d1/git-meta?repo=site`, auth(await serviceToken())), { params: Promise.resolve({ driveId: "d1" }) });
    expect(ok.status).toBe(200);
    // `site` is not under repositories/, so its clone URL is the drive-id form
    expect(await ok.json()).toMatchObject({ exists: true, branch: "main", cloneUrl: expect.stringContaining("/api/drives/d1/git/site") });
    const other = await metaRoute.GET(new Request(`${PUBLIC_URL}/api/drives/d2/git-meta?repo=site`, auth(await serviceToken())), { params: Promise.resolve({ driveId: "d2" }) });
    expect(other.status).toBe(403);
    const bad = await metaRoute.GET(new Request(`${PUBLIC_URL}/api/drives/d1/git-meta?repo=site`, auth(await serviceToken({ aud: "https://x.example.test" }))), { params: Promise.resolve({ driveId: "d1" }) });
    expect(bad.status).toBe(401);
    const anon = await metaRoute.GET(new Request(`${PUBLIC_URL}/api/drives/d1/git-meta?repo=site`), { params: Promise.resolve({ driveId: "d1" }) });
    expect(anon.status).toBe(401); // the cookie path is unchanged
  });
});
