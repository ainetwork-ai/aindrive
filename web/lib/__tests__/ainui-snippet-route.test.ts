// AIN-UI link snippets over HTTP (docs/AINUI-LINK-SNIPPETS.md): the pretty-URL
// route (app/[slug]/git/[...path]) negotiating `Accept: application/vnd.ain.ui+json`,
// the consumer's machine token + `X-AIN-Actor` resolved to the person's own drive
// role (lib/ainui-actor.ts), and the run route pressed by a consumer for a person —
// against the real slug resolver, gate and db, with the drive agent stubbed and
// AIN SSO replaced by an in-test key.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createTestIssuer, ISSUER, PUBLIC_URL } from "./sso-test-issuer";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-ainui-snippet-"));
process.env.AINDRIVE_PUBLIC_URL = PUBLIC_URL;
process.env.AINDRIVE_SESSION_SECRET = "ainui-snippet-test-secret-0123456789abcdef";
process.env.AINDRIVE_SSO_ISSUER = ISSUER;
process.env.AINDRIVE_SSO_CLIENT_ID = "app_aindrive";
process.env.AINDRIVE_SSO_SERVICE_APPS = "ainteams, ainize";
process.env.AINIZE_URL = "https://ainize.example.test";

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({
    get: (name: string) => { const v = cookieJar.get(name); return v === undefined ? undefined : { name, value: v }; },
    set: (name: string, value: string) => { cookieJar.set(name, value); },
    delete: (name: string) => { cookieJar.delete(name); },
  }),
  headers: () => Promise.resolve(new Headers()),
}));

type Call = Record<string, unknown>;
const WC = "repositories/clef";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const MANIFEST = JSON.stringify({ kind: "script", entry: "art_search.py", inputs: { DESC: { description: "작품 묘사", required: true, default: "a harbour" } } });
const agent = { calls: [] as Call[], offline: false, manifest: true };
vi.mock("../rpc", () => ({
  AgentError: class extends Error { status: number; constructor(m: string, s = 502) { super(m); this.status = s; } },
  isOnline: () => true,
  callAgent: async (_d: string, _s: string, req: Call) => {
    agent.calls.push(req);
    if (agent.offline) throw Object.assign(new Error("agent offline"), { status: 504 });
    if (req.method === "git-meta") return req.repo === WC
      ? { method: "git-meta", exists: true, branch: "main", head: { sha: HEAD, subject: "run as the person", author: "Ann", date: "2026-10-10" }, dirty: 0, commits: [], layout: "working-copy", ahead: 0, behind: 0 }
      : { method: "git-meta", exists: false };
    if (req.method === "read") { if (agent.manifest && req.path === `${WC}/ainize.json`) return { method: "read", content: MANIFEST, encoding: "utf8" }; if (req.path === `${WC}/art_search.py`) return { method: "read", content: "print('hi')\n", encoding: "utf8" }; throw new Error("no such file"); }
    if (req.method === "list") return { entries: [{ name: "art_search.py", path: `${WC}/art_search.py`, isDir: false, size: 12 }, { name: "ainize.json", path: `${WC}/ainize.json`, isDir: false, size: MANIFEST.length }] };
    if (req.method === "git-show") {
      if (req.path === "missing.py") throw new Error("no such path at ref");
      if (req.path === "logo.png") return { method: "git-show", sha: HEAD, size: 4, content: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"), truncated: false };
      return { method: "git-show", sha: HEAD, size: 12, content: Buffer.from("print('v1')\nprint('v2')\n").toString("base64"), truncated: false };
    }
    return { ok: true };
  },
}));

const issuer = await createTestIssuer();
const { db } = await import("../db.js");
const orgs = await import("../orgs.js");
const { adapterJwksUrl, setJwksForTests } = await import("../sso/oidc");
const { AINUI_MEDIA_TYPE } = await import("../ainui-snippet");
const slugRoute = await import("../../app/[slug]/git/[...path]/route");
const runRoute = await import("../../app/api/drives/[driveId]/run/route");
setJwksForTests(adapterJwksUrl(ISSUER), issuer.keys);

const COMCOM = { id: "org_comcom", slug: "comcom", name: "ComCom" };
const nowS = () => Math.floor(Date.now() / 1000);
function appToken(o: { app?: string; aud?: string; orgs?: string[] } = {}) {
  const app = o.app ?? "ainteams";
  return issuer.sign({ iss: ISSUER, aud: o.aud ?? PUBLIC_URL, sub: app, azp: app, client_id: app, jti: randomUUID(), orgs: o.orgs ?? [] }, { typ: "at+jwt", exp: nowS() + 300 });
}
const REPO = `${PUBLIC_URL}/comcom/git/clef`;
const ctx = (slug: string, path: string[]) => ({ params: Promise.resolve({ slug, path }) });
const get = (url: string, headers: Record<string, string>, path = url.slice(PUBLIC_URL.length).split("/").filter(Boolean)) =>
  slugRoute.GET(new Request(url, { headers }), ctx(path[0], path.slice(2)));
const ui = async (actor: string | null, path = ["clef"], extra: Record<string, string> = {}) => {
  const headers: Record<string, string> = { accept: AINUI_MEDIA_TYPE, authorization: `Bearer ${await appToken()}`, ...extra };
  if (actor) headers["x-ain-actor"] = actor;
  return slugRoute.GET(new Request(`${PUBLIC_URL}/comcom/git/${path.join("/")}`, { headers }), ctx("comcom", path));
};
const body = async (res: Response) => JSON.parse(await res.text());

beforeAll(() => {
  const u = db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)");
  u.run("owner1", "o@example.com", "Owner", "x"); u.run("member1", "m@example.com", "Member", "x"); u.run("stranger1", "s@example.com", "Stranger", "x");
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)").run("d1", "owner1", "comcom", "h", "s");
  const m = db.prepare(
    `INSERT INTO sso_memberships (issuer, org_id, subject, user_id, org_slug, org_name, status, app_role, groups_json, applied_version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', 'member', '[]', 1, ?)`,
  );
  m.run(ISSUER, COMCOM.id, "acc_owner", "owner1", COMCOM.slug, COMCOM.name, Date.now());
  m.run(ISSUER, COMCOM.id, "acc_member", "member1", COMCOM.slug, COMCOM.name, Date.now());
  const ident = db.prepare("INSERT INTO sso_identities (issuer, subject, user_id, link_method, linked_at) VALUES (?,?,?,?,?)");
  ident.run(ISSUER, "acc_owner", "owner1", "jit", Date.now()); ident.run(ISSUER, "acc_member", "member1", "jit", Date.now()); ident.run(ISSUER, "acc_stranger", "stranger1", "jit", Date.now());
  orgs.shareDriveWithOrg({ driveId: "d1", issuer: ISSUER, orgId: COMCOM.id, role: "viewer", actor: "operator", via: "operator" });
});
beforeEach(() => { agent.calls.length = 0; agent.offline = false; agent.manifest = true; cookieJar.clear(); });

// ainize is not reachable from the test: by-repo answers 404 → no deployments block.
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const ainizeDown = () => { globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch; };

describe("negotiation", () => {
  it("without the UI media type the route is untouched: a git client path is still git, a page path is still not found", async () => {
    const res = await get(`${REPO}/blob/main/art_search.py`, { accept: "application/json" });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).not.toBe(AINUI_MEDIA_TYPE);
    expect(agent.calls).toEqual([]);
    const page = await get(`${REPO}/blob/main/art_search.py`, { accept: `text/html, ${AINUI_MEDIA_TYPE}` });
    expect(page.headers.get("content-type")).not.toBe(AINUI_MEDIA_TYPE); // a browser never gets the snippet
  });

  it("the UI media type without a machine token is 401 — a cookie is not an identity a consumer can forward", async () => {
    const res = await get(REPO, { accept: AINUI_MEDIA_TYPE });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe(AINUI_MEDIA_TYPE);
    expect(agent.calls).toEqual([]);
    const bad = await get(REPO, { accept: AINUI_MEDIA_TYPE, authorization: `Bearer ${await appToken({ app: "stranger-app" })}`, "x-ain-actor": "acc_owner" });
    expect(bad.status).toBe(401);
    expect(await body(bad)).toMatchObject({ error: "invalid service token", reason: "untrusted_app" });
    expect(bad.headers.get("www-authenticate")).toMatch(/invalid_token/);
    const wrongAud = await get(REPO, { accept: AINUI_MEDIA_TYPE, authorization: `Bearer ${await appToken({ aud: "https://elsewhere.example.test" })}`, "x-ain-actor": "acc_owner" });
    expect(wrongAud.status).toBe(401);
  });
});

describe("the repo snippet", () => {
  it("is built for an org member, run block from ainize.json, Open link to the pretty URL", async () => {
    ainizeDown();
    const res = await ui("acc_member");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(AINUI_MEDIA_TYPE);
    expect(res.headers.get("vary")).toContain("X-AIN-Actor");
    const s = await body(res);
    expect(s).toMatchObject({ ainui: 1, kind: "aindrive.repo", title: "comcom/clef", subtitle: "main · 0123456 run as the person", url: REPO });
    expect(s.actions.run).toEqual({ method: "POST", url: `${PUBLIC_URL}/api/drives/d1/run`, body: { repo: WC, entry: "art_search.py", env: { $context: true } }, stream: "sse", output: { path: "/run/output", status: "/run/status" } });
    expect(s.actions["open:aindrive"]).toEqual({ method: "GET", url: REPO, navigate: true });
    const ids = s.surface[1].updateComponents.components.map((c: { id: string }) => c.id);
    expect(ids).toContain("run.input.DESC");
    expect(ids).not.toContain("deployments");
    expect(s.surface[2].updateDataModel.value.inputs).toEqual({ DESC: "a harbour" });
    // The gate ran before the agent was asked anything; the agent read meta and the manifest, nothing else.
    expect(agent.calls.map((c) => c.method)).toEqual(["git-meta", "read"]);
  });

  it("names the root's first runnable file when there is no ainize.json", async () => {
    ainizeDown(); agent.manifest = false;
    const s = await body(await ui("acc_member"));
    expect(s.actions.run.body.entry).toBe("art_search.py");
    expect(s.surface[2].updateDataModel.value.inputs).toEqual({});
  });

  it("a tree URL inside the repo and a commits URL answer the repo snippet too", async () => {
    ainizeDown();
    expect((await body(await ui("acc_member", ["clef", "tree", "main", "lib"]))).kind).toBe("aindrive.repo");
    expect((await body(await ui("acc_member", ["clef", "commits", "main"]))).kind).toBe("aindrive.repo");
  });

  it("includes the Deployments block from ainize when the repo is bound (public row, then the list for the actor)", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      if (url.includes("/api/projects/by-repo")) return Response.json({ id: "prj_1", org: "comcom", repoName: "clef", repo: REPO, branch: "main", kind: "script", status: "ready", url: "https://ainize.example.test/comcom/clef", pageUrl: "https://ainize.example.test/projects/prj_1", lastDeployment: { id: "dep_2", sha: "bbbbbbbb1", status: "ready", finishedAt: Date.now() - 60_000, outputUrl: "https://ainize.example.test/api/deployments/dep_2/output" } });
      if (url.includes("/api/projects/prj_1/deployments")) return Response.json({ deployments: [{ id: "dep_2", sha: "bbbbbbbb1", status: "ready", finishedAt: Date.now() - 60_000 }, { id: "dep_1", sha: "aaaaaaaa1", status: "error", exitCode: 1, finishedAt: Date.now() - 3_600_000 }] });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const s = await body(await ui("acc_member"));
    const byRepo = seen.find((x) => x.url.includes("by-repo"))!;
    expect(byRepo.url).toBe(`https://ainize.example.test/api/projects/by-repo?repo=${encodeURIComponent(REPO)}`);
    // aindrive has no app credentials in this test, so the list is not asked for and the newest row (from by-repo) is shown.
    expect(seen.some((x) => x.url.includes("/deployments"))).toBe(false);
    const ids = s.surface[1].updateComponents.components.map((c: { id: string }) => c.id);
    expect(ids).toContain("deployments.0");
    expect(ids).not.toContain("deployments.1");
    expect(s.actions["open:inspect"]).toEqual({ method: "GET", url: "https://ainize.example.test/projects/prj_1", navigate: true });
    expect(s.actions["open:visit:0"].url).toBe("https://ainize.example.test/api/deployments/dep_2/output");
    expect(s.refresh).toBe(30);
  });
});

describe("the file snippet", () => {
  it("previews the file at the ref and offers ▶ Run for a runnable file on the checked-out branch", async () => {
    const s = await body(await ui("acc_member", ["clef", "blob", "main", "art_search.py"]));
    expect(s).toMatchObject({ kind: "aindrive.file", title: "art_search.py", url: `${REPO}/blob/main/art_search.py` });
    const comps = s.surface[1].updateComponents.components;
    expect(comps.find((c: { id: string }) => c.id === "file.code").text).toBe("print('v1')\nprint('v2')\n");
    expect(s.actions.run.body).toEqual({ repo: WC, entry: "art_search.py", env: { $context: true } });
    expect(s.actions["open:raw"].url).toBe(`${REPO}/raw/main/art_search.py`);
    expect(agent.calls.find((c) => c.method === "git-show")).toMatchObject({ repo: WC, ref: "main", path: "art_search.py" });
  });

  it("`HEAD` means the checked-out branch — the same snippet and ▶ Run as the branch URL (a consumer that knows only the drive path)", async () => {
    const byHead = await body(await ui("acc_member", ["clef", "blob", "HEAD", "art_search.py"]));
    const byBranch = await body(await ui("acc_member", ["clef", "blob", "main", "art_search.py"]));
    expect(byHead).toEqual(byBranch);
    expect(byHead.actions.run).toBeDefined();
  });

  it("at another ref the file is shown but not runnable (the run executes the working tree); a binary file says so", async () => {
    const other = await body(await ui("acc_member", ["clef", "blob", "dev", "art_search.py"]));
    expect(other.actions.run).toBeUndefined();
    const bin = await body(await ui("acc_member", ["clef", "blob", "main", "logo.png"]));
    expect(bin.surface[1].updateComponents.components.find((c: { id: string }) => c.id === "file.code").text).toMatch(/binary file/);
    expect(bin.actions.run).toBeUndefined();
  });

  it("a missing file is 404 with the plain body", async () => {
    const res = await ui("acc_member", ["clef", "blob", "main", "missing.py"]);
    expect(res.status).toBe(404);
    expect(await body(res)).toEqual({ error: "not found" });
  });
});

describe("who may see it", () => {
  it("an actor with no access gets 403 and the minimal sign-in surface, before the agent is asked", async () => {
    const res = await ui("acc_stranger");
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toBe(AINUI_MEDIA_TYPE);
    const s = await body(res);
    expect(s).toMatchObject({ ainui: 1, kind: "denied", icon: "lock", title: "comcom/clef", url: REPO });
    expect(s.surface[1].updateComponents.components.find((c: { id: string }) => c.id === "denied.text").text).toBe("Sign in to drive.example.test or ask for access to comcom/clef.");
    expect(s.actions).toEqual({ "open:aindrive": { method: "GET", url: REPO, navigate: true } });
    expect(agent.calls).toEqual([]);
  });

  it("an actor nobody here is linked to is a person with no access (403), not an error", async () => {
    const res = await ui("acc_unknown");
    expect(res.status).toBe(403);
    expect((await body(res)).kind).toBe("denied");
  });

  it("the application itself (no actor) is a viewer on the drive only through an in-force org share", async () => {
    ainizeDown();
    const ok = await get(REPO, { accept: AINUI_MEDIA_TYPE, authorization: `Bearer ${await appToken({ orgs: [COMCOM.id] })}` });
    expect(ok.status).toBe(200);
    const no = await get(REPO, { accept: AINUI_MEDIA_TYPE, authorization: `Bearer ${await appToken({ orgs: ["org_other"] })}` });
    expect(no.status).toBe(403);
  });

  it("an unknown org slug, a non-repo folder and a reserved path are not found; an offline drive is 503", async () => {
    const unknown = await slugRoute.GET(new Request(`${PUBLIC_URL}/nobody/git/clef`, { headers: { accept: AINUI_MEDIA_TYPE, authorization: `Bearer ${await appToken()}`, "x-ain-actor": "acc_member" } }), ctx("nobody", ["clef"]));
    expect(unknown.status).toBe(404);
    expect(await body(unknown)).toEqual({ error: "not found" });
    expect((await ui("acc_member", ["plain-folder"])).status).toBe(404);
    expect((await ui("acc_member", [".aindrive"])).status).toBe(404);
    agent.offline = true;
    const off = await ui("acc_member");
    expect(off.status).toBe(503);
    expect(await body(off)).toEqual({ error: "drive offline" });
  });
});

describe("the run action pressed by a consumer for a person", () => {
  const press = async (actor: string | null, token?: string) => {
    const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${token ?? (await appToken())}` };
    if (actor) headers["x-ain-actor"] = actor;
    return runRoute.POST(new Request(`${PUBLIC_URL}/api/drives/d1/run`, { method: "POST", headers, body: JSON.stringify({ repo: WC, entry: "art_search.py", env: { INPUT_DESC: "a harbour" } }) }), { params: Promise.resolve({ driveId: "d1" }) });
  };

  it("runs for the actor: their gate, the files through the agent, the stream relayed unchanged", async () => {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body ?? "") });
      return new Response('event: stdout\ndata: "hi\\n"\n\nevent: exit\ndata: {"code":0,"ms":5}\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const res = await press("acc_member");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toContain('event: exit');
    expect(seen[0].url).toBe("https://ainize.example.test/api/run");
    const sent = JSON.parse(seen[0].body);
    expect(sent).toMatchObject({ language: "python", entry: "art_search.py", env: { INPUT_DESC: "a harbour" } });
    expect(sent.files.map((f: { path: string }) => f.path)).toContain("art_search.py");
    // aindrive has no app credentials here, so the run is anonymous towards ainize; with them the actor would be named.
    expect(seen[0].headers["x-ain-actor"]).toBeUndefined();
  });

  it("refuses a stranger (403), an application naming nobody (403) and a bad token (401) — never a silent anonymous run", async () => {
    globalThis.fetch = (async () => { throw new Error("must not reach ainize"); }) as typeof fetch;
    expect((await press("acc_stranger")).status).toBe(403);
    expect((await press(null)).status).toBe(403);
    const bad = await press("acc_member", await appToken({ app: "stranger-app" }));
    expect(bad.status).toBe(401);
    expect(await body(bad)).toMatchObject({ error: "invalid service token" });
  });
});
