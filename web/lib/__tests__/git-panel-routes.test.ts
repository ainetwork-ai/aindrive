// The web git panel's three routes — git-meta (viewer), git-commit (editor),
// run (viewer, relays ainize's event stream) — against the real gate and db,
// with the CLI agent replaced by a recording stub and ainize by a fetch mock.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-gitpanel-"));
process.env.AINDRIVE_PUBLIC_URL = "https://drive.example.test";
process.env.AINIZE_URL = "https://ainize.example.test/";

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({
    get: (name: string) => { const v = cookieJar.get(name); return v === undefined ? undefined : { name, value: v }; },
    set: (name: string, value: string) => { cookieJar.set(name, value); },
    delete: (name: string) => { cookieJar.delete(name); },
  }),
}));

type Call = Record<string, unknown>;
const agent = { calls: [] as Call[], meta: null as Call | null, dirty: 2, files: {} as Record<string, string>, status: null as Call | null, pushMoves: true };
vi.mock("../rpc", () => ({
  AgentError: class extends Error { status: number; constructor(m: string, s = 502) { super(m); this.status = s; } },
  callAgent: async (_d: string, _s: string, req: Call) => {
    agent.calls.push(req);
    switch (req.method) {
      case "git-meta":
        return agent.meta ?? { method: "git-meta", exists: false };
      case "git-commit":
        if (!String(req.message).trim()) throw new Error("commit message required");
        if (agent.dirty === 0) throw new Error("nothing to commit");
        if (req.all === false && !(agent.status?.staged as unknown[] | undefined)?.length) throw new Error("nothing staged — stage changes first, or commit all");
        return { method: "git-commit", sha: "abc1234abc1234abc1234abc1234abc1234abc12" };
      case "git-status":
        if (!agent.status) throw new Error("not a git repository");
        return { method: "git-status", ...agent.status };
      case "git-stage": return { method: "git-stage", ok: true };
      case "git-discard": return { method: "git-discard", ok: true, tracked: 1, untracked: 0 };
      case "git-push":
        return { method: "git-push", ok: true, ref: "refs/heads/main", before: agent.pushMoves ? "1".repeat(40) : "2".repeat(40), after: "2".repeat(40) };
      case "git-pull":
        if (agent.dirty > 0) throw new Error("working copy has changes — commit or discard them first");
        return { method: "git-pull", ok: true, sha: "2".repeat(40) };
      case "stat":
        return { method: "stat", entry: (req.path as string) in agent.files ? { name: String(req.path).split("/").pop(), path: req.path, isDir: false, size: agent.files[req.path as string].length, mtimeMs: 1, ext: "py", mime: "text/x-python" } : null };
      case "write":
        agent.files[req.path as string] = String(req.content);
        return { method: "write", ok: true, bytes: String(req.content).length };
      case "list":
        if (req.path === "proj") return { entries: [
          { name: "main.py", path: "proj/main.py", isDir: false, size: 12 },
          { name: "logo.png", path: "proj/logo.png", isDir: false, size: 5 },
          { name: "node_modules", path: "proj/node_modules", isDir: true, size: 0 },
          { name: "lib", path: "proj/lib", isDir: true, size: 0 },
        ] };
        if (req.path === "proj/lib") return { entries: [{ name: "util.py", path: "proj/lib/util.py", isDir: false, size: 3 }] };
        return { entries: [] };
      case "read":
        return { method: "read", content: agent.files[req.path as string] ?? `# ${req.path}\n`, encoding: "utf8" };
    }
    return { ok: true };
  },
}));

const { db } = await import("../db.js");
const { sign } = await import("../session.js");
const metaRoute = await import("../../app/api/drives/[driveId]/git-meta/route");
const commitRoute = await import("../../app/api/drives/[driveId]/git-commit/route");
const runRoute = await import("../../app/api/drives/[driveId]/run/route");
const scRoute = await import("../../app/api/drives/[driveId]/git-sc/route");
const writeRoute = await import("../../app/api/drives/[driveId]/fs/write/route");
const hooks = await import("../git-project-hooks");

const ctx = { params: Promise.resolve({ driveId: "d1" }) };
const post = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const as = async (userId: string | null) => { if (userId) cookieJar.set("aindrive_session", await sign(userId)); else cookieJar.delete("aindrive_session"); };

const HEAD = { sha: "0123456789abcdef0123456789abcdef01234567", subject: "feat: thing", author: "Min", date: "2026-10-09T12:00:00Z" };
const META = { method: "git-meta", exists: true, branch: "main", head: HEAD, dirty: 2, commits: [HEAD], layout: "working-copy", ahead: 0, behind: 0 };
const STATUS = { branch: "main", staged: [], unstaged: [{ path: "main.py", status: "M" }], untracked: [{ path: "new.txt", status: "U" }], ahead: 0, behind: 0, hasRemote: true };

beforeAll(() => {
  const u = db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)");
  u.run("owner1", "o@example.com", "Owner", "x");
  u.run("ed1", "editor@example.com", "Ed Itor", "x");
  u.run("vw1", "v@example.com", "Viewer", "x");
  u.run("nobody", "n@example.com", "Nobody", "x");
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)").run("d1", "owner1", "D1", "h", "s");
  const m = db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)");
  m.run("m1", "d1", "ed1", "", "editor");
  m.run("m2", "d1", "vw1", "", "viewer");
});
beforeEach(() => { agent.calls.length = 0; agent.meta = { ...META }; agent.dirty = 2; agent.files = {}; agent.status = { ...STATUS }; agent.pushMoves = true; db.prepare("DELETE FROM git_project_hooks").run(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("GET git-meta", () => {
  it("answers the agent's summary plus the drive-id clone URL to a viewer", async () => {
    await as("vw1");
    const res = await metaRoute.GET(new Request("http://x/api?repo=proj"), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ exists: true, branch: "main", dirty: 2, head: HEAD, commits: [HEAD], layout: "working-copy", status: STATUS });
    expect(body.cloneUrl).toBe("https://drive.example.test/api/drives/d1/git/proj");
    expect(body.ainizeUrl).toBe("https://ainize.example.test");
    // git-meta first; then the manifest read / root list for the panel's Run row.
    expect(agent.calls[0]).toEqual({ method: "git-meta", repo: "proj" });
    expect(body.manifest).toBeNull();
    expect(body.entry).toBe("main.py");
  });

  it("answers exists:false for a plain folder, and refuses a stranger before asking the agent", async () => {
    await as("vw1");
    agent.meta = { method: "git-meta", exists: false };
    expect(await (await metaRoute.GET(new Request("http://x/api?repo=plain"), ctx)).json()).toEqual({ exists: false });
    await as("nobody");
    expect((await metaRoute.GET(new Request("http://x/api?repo=proj"), ctx)).status).toBe(403);
    await as(null);
    expect((await metaRoute.GET(new Request("http://x/api?repo=proj"), ctx)).status).toBe(401);
    expect((await metaRoute.GET(new Request("http://x/api"), ctx)).status).toBe(400);
    expect(agent.calls.filter((c) => c.method === "git-meta")).toHaveLength(1);
  });
});

describe("POST git-commit", () => {
  it("commits as the signed-in editor (name + email) and returns the sha", async () => {
    await as("ed1");
    const res = await commitRoute.POST(post("http://x/api", { repo: "proj", message: "  fix typo " }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sha: "abc1234abc1234abc1234abc1234abc1234abc12" });
    expect(agent.calls).toEqual([{ method: "git-commit", repo: "proj", message: "fix typo", all: true, authorName: "Ed Itor", authorEmail: "editor@example.com" }]);
    // staged-only: the agent refuses when nothing is staged
    const none = await commitRoute.POST(post("http://x/api", { repo: "proj", message: "staged only", all: false }), ctx);
    expect(none.status).toBe(400);
    expect((await none.json()).error).toMatch(/nothing staged/);
  });

  it("a viewer cannot commit; an empty message or a clean tree is a 400", async () => {
    await as("vw1");
    expect((await commitRoute.POST(post("http://x/api", { repo: "proj", message: "m" }), ctx)).status).toBe(403);
    expect(agent.calls).toEqual([]);
    await as("owner1");
    const empty = await commitRoute.POST(post("http://x/api", { repo: "proj", message: "   " }), ctx);
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toMatch(/message required/);
    agent.dirty = 0;
    const clean = await commitRoute.POST(post("http://x/api", { repo: "proj", message: "m" }), ctx);
    expect(clean.status).toBe(400);
    expect((await clean.json()).error).toBe("nothing to commit");
  });
});

describe("POST run", () => {
  const sse = "event: stdout\ndata: {\"text\":\"hi\\n\"}\n\nevent: exit\ndata: {\"code\":0,\"durationMs\":42}\n\n";

  it("ships the repo's text files (skipping binaries and node_modules) to ainize and relays its stream", async () => {
    await as("vw1");
    const fetchMock = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await runRoute.POST(post("http://x/api", { repo: "proj", entry: "main.py" }), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe(sse);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ainize.example.test/api/run");
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({
      language: "python", entry: "main.py",
      files: [{ path: "main.py", content: "# proj/main.py\n" }, { path: "lib/util.py", content: "# proj/lib/util.py\n" }],
      env: {},
      timeoutMs: 120000,
    });
    // a viewer with no SSO identity: an anonymous run — no bearer, nobody named
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    expect((init.headers as Record<string, string>)["x-ain-actor"]).toBeUndefined();
    // .git is hidden by the agent; node_modules was never listed into.
    expect(agent.calls.filter((c) => c.method === "list").map((c) => c.path)).toEqual(["proj", "proj/lib"]);
  });

  it("forwards the person's answers to the manifest's inputs as env, nothing of ours; refuses bad env", async () => {
    await as("vw1");
    const fetchMock = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await runRoute.POST(post("http://x/api", { repo: "proj", entry: "main.py", env: { INPUT_DESC: "해질녘 바다", INPUT_TOP_K: 5, INPUT_DRY: true } }), ctx);
    expect(res.status).toBe(200);
    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.env).toEqual({ INPUT_DESC: "해질녘 바다", INPUT_TOP_K: "5", INPUT_DRY: "true" });
    for (const env of [{ "bad-name": "x" }, { A: "x".repeat(2049) }, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`I${i}`, "v"])), [1], "x", { A: { nested: 1 } }]) {
      const bad = await runRoute.POST(post("http://x/api", { repo: "proj", entry: "main.py", env }), ctx);
      expect(bad.status, JSON.stringify(env).slice(0, 40)).toBe(400);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("runs AS the person: aindrive's machine token for ainize + X-AIN-Actor = the viewer's SSO subject; ainize's 403 is relayed", async () => {
    const ISSUER = "https://sso.example.test";
    const saved = { ...process.env };
    process.env.AINDRIVE_SSO_ISSUER = ISSUER;
    process.env.AINDRIVE_SSO_CLIENT_ID = "aindrive";
    process.env.AINDRIVE_SSO_CLIENT_SECRET = "aindrive-secret";
    const { resetServiceTokensForTests } = await import("../sso/service-token");
    resetServiceTokensForTests();
    db.prepare("INSERT INTO sso_identities (issuer, subject, user_id, link_method, linked_at) VALUES (?,?,?,?,?)").run(ISSUER, "acc_viewer", "vw1", "test", Date.now());
    const seen: { url: string; init: RequestInit }[] = [];
    let runAnswer: () => Response = () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.push({ url, init: init ?? {} });
      if (url === `${ISSUER}/.well-known/openid-configuration`) return Response.json({ issuer: ISSUER, token_endpoint: `${ISSUER}/oidc/token`, jwks_uri: `${ISSUER}/oidc/jwks` });
      if (url === `${ISSUER}/oidc/token`) {
        // client_credentials for the ainize origin, as aindrive itself
        expect(String(init?.body)).toBe("grant_type=client_credentials&resource=https%3A%2F%2Fainize.example.test");
        return Response.json({ access_token: "svc_token_for_ainize", token_type: "Bearer", expires_in: 300 });
      }
      if (url === "https://ainize.example.test/api/run") return runAnswer();
      return new Response("not found", { status: 404 });
    }));
    try {
      await as("vw1");
      const res = await runRoute.POST(post("http://x/api", { repo: "proj", entry: "main.py" }), ctx);
      expect(res.status).toBe(200);
      const run = seen.find((s) => s.url.endsWith("/api/run"))!;
      const headers = run.init.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer svc_token_for_ainize");
      expect(headers["x-ain-actor"]).toBe("acc_viewer");
      expect(JSON.parse(run.init.body as string).env).toEqual({});
      // the token is cached: a second press mints nothing new
      await runRoute.POST(post("http://x/api", { repo: "proj", entry: "main.py" }), ctx);
      expect(seen.filter((s) => s.url === `${ISSUER}/oidc/token`)).toHaveLength(1);
      // ainize refusing the person (suspended) or us (untrusted app) is seen as such, not as a runner error
      runAnswer = () => Response.json({ error: "account_suspended", message: "This account is suspended." }, { status: 403 });
      const refused = await runRoute.POST(post("http://x/api", { repo: "proj", entry: "main.py" }), ctx);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: "account_suspended", detail: "This account is suspended." });
      // a person with no SSO identity still runs — anonymously, with no key on ainize's side
      await as("ed1");
      runAnswer = () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      await runRoute.POST(post("http://x/api", { repo: "proj", entry: "main.py" }), ctx);
      const anon = seen.at(-1)!.init.headers as Record<string, string>;
      expect(anon.authorization).toBeUndefined();
      expect(anon["x-ain-actor"]).toBeUndefined();
    } finally {
      db.prepare("DELETE FROM sso_identities WHERE subject = ?").run("acc_viewer");
      for (const k of ["AINDRIVE_SSO_ISSUER", "AINDRIVE_SSO_CLIENT_ID", "AINDRIVE_SSO_CLIENT_SECRET"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      resetServiceTokensForTests();
    }
  });

  it("relays ainize 503 as 'runner unavailable', and refuses bad entries / strangers before contacting ainize", async () => {
    const fetchMock = vi.fn(async () => new Response("no runner", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await as("vw1");
    const down = await runRoute.POST(post("http://x/api", { repo: "proj", entry: "main.py" }), ctx);
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: "runner unavailable" });
    expect((await runRoute.POST(post("http://x/api", { repo: "proj", entry: "README.md" }), ctx)).status).toBe(400);
    expect((await runRoute.POST(post("http://x/api", { repo: "proj", entry: "../x.py" }), ctx)).status).toBe(400);
    expect((await runRoute.POST(post("http://x/api", { repo: "proj", entry: "missing.py" }), ctx)).status).toBe(404);
    await as("nobody");
    expect((await runRoute.POST(post("http://x/api", { repo: "proj", entry: "main.py" }), ctx)).status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("edit → save → run", () => {
  const sse = "event: exit\ndata: {\"code\":0}\n\n";
  it("Run executes what was just saved: the run route gathers the working tree through the agent at click time", async () => {
    await as("ed1");
    const fetchMock = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    // first run: the file as the stub serves it
    await runRoute.POST(post("http://x/api", { repo: "proj", entry: "main.py" }), ctx);
    let sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.files.find((f: { path: string }) => f.path === "main.py").content).toBe("# proj/main.py\n");
    // the editor saves new content (fs/write → agent `write`) …
    const w = await writeRoute.POST(post("http://x/api", { path: "proj/main.py", content: "print('edited')\n", encoding: "utf8" }), ctx);
    expect(w.status).toBe(200);
    // … and the next Run ships exactly that — no snapshot, no last commit
    await runRoute.POST(post("http://x/api", { repo: "proj", entry: "main.py" }), ctx);
    sent = JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.files.find((f: { path: string }) => f.path === "main.py").content).toBe("print('edited')\n");
    const reads = agent.calls.filter((c) => c.method === "read" && c.path === "proj/main.py");
    expect(reads).toHaveLength(2); // one live read per run
  });
});

describe("git-sc (source control)", () => {
  it("GET answers the working copy's status to a viewer; a stranger is refused", async () => {
    await as("vw1");
    const res = await scRoute.GET(new Request("http://x/api?repo=proj"), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(STATUS);
    agent.status = null;
    expect((await scRoute.GET(new Request("http://x/api?repo=plain"), ctx)).status).toBe(404);
    await as("nobody");
    expect((await scRoute.GET(new Request("http://x/api?repo=proj"), ctx)).status).toBe(403);
  });

  it("stage / unstage / discard forward the paths to the agent (editors only; paths required)", async () => {
    await as("ed1");
    expect((await scRoute.POST(post("http://x/api", { repo: "proj", action: "stage", paths: ["main.py", "new.txt"] }), ctx)).status).toBe(200);
    expect((await scRoute.POST(post("http://x/api", { repo: "proj", action: "unstage", paths: ["main.py"] }), ctx)).status).toBe(200);
    const d = await scRoute.POST(post("http://x/api", { repo: "proj", action: "discard", paths: ["main.py"] }), ctx);
    expect(await d.json()).toEqual({ ok: true, tracked: 1, untracked: 0 });
    expect(agent.calls).toEqual([
      { method: "git-stage", repo: "proj", paths: ["main.py", "new.txt"], unstage: false },
      { method: "git-stage", repo: "proj", paths: ["main.py"], unstage: true },
      { method: "git-discard", repo: "proj", paths: ["main.py"] },
    ]);
    expect((await scRoute.POST(post("http://x/api", { repo: "proj", action: "stage" }), ctx)).status).toBe(400);
    await as("vw1");
    expect((await scRoute.POST(post("http://x/api", { repo: "proj", action: "stage", paths: ["x"] }), ctx)).status).toBe(403);
  });

  it("push moves the working copy into the bare remote and fires the bound project's hook — the deploy trigger; pull fast-forwards only a clean copy", async () => {
    await as("ed1");
    hooks.storeProjectHook("d1", "proj", "prj_1", "whsec_test_secret_x", "ed1");
    const hookFetch = vi.fn(async () => new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", hookFetch);
    const res = await scRoute.POST(post("http://x/api", { repo: "proj", action: "push" }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ref: "refs/heads/main", before: "1".repeat(40), after: "2".repeat(40), moved: true });
    await vi.waitFor(() => expect(hookFetch).toHaveBeenCalledTimes(1));
    const [url, init] = hookFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ainize.example.test/api/projects/prj_1/hook");
    expect(JSON.parse(init.body as string)).toMatchObject({ ref: "refs/heads/main", before: "1".repeat(40), after: "2".repeat(40) });
    // nothing moved → no hook
    agent.pushMoves = false;
    expect((await (await scRoute.POST(post("http://x/api", { repo: "proj", action: "push" }), ctx)).json()).moved).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(hookFetch).toHaveBeenCalledTimes(1);
    // pull: refused while dirty (the agent's message), fine when clean
    const dirty = await scRoute.POST(post("http://x/api", { repo: "proj", action: "pull" }), ctx);
    expect(dirty.status).toBe(400);
    expect((await dirty.json()).error).toMatch(/has changes/);
    agent.dirty = 0;
    expect(await (await scRoute.POST(post("http://x/api", { repo: "proj", action: "pull" }), ctx)).json()).toEqual({ ok: true, sha: "2".repeat(40) });
  });
});
