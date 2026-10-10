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
const agent = { calls: [] as Call[], meta: null as Call | null, dirty: 2 };
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
        return { method: "git-commit", sha: "abc1234abc1234abc1234abc1234abc1234abc12" };
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
        return { method: "read", content: `# ${req.path}\n`, encoding: "utf8" };
    }
    return { ok: true };
  },
}));

const { db } = await import("../db.js");
const { sign } = await import("../session.js");
const metaRoute = await import("../../app/api/drives/[driveId]/git-meta/route");
const commitRoute = await import("../../app/api/drives/[driveId]/git-commit/route");
const runRoute = await import("../../app/api/drives/[driveId]/run/route");

const ctx = { params: Promise.resolve({ driveId: "d1" }) };
const post = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const as = async (userId: string | null) => { if (userId) cookieJar.set("aindrive_session", await sign(userId)); else cookieJar.delete("aindrive_session"); };

const HEAD = { sha: "0123456789abcdef0123456789abcdef01234567", subject: "feat: thing", author: "Min", date: "2026-10-09T12:00:00Z" };
const META = { method: "git-meta", exists: true, branch: "main", head: HEAD, dirty: 2, commits: [HEAD] };

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
beforeEach(() => { agent.calls.length = 0; agent.meta = { ...META }; agent.dirty = 2; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("GET git-meta", () => {
  it("answers the agent's summary plus the drive-id clone URL to a viewer", async () => {
    await as("vw1");
    const res = await metaRoute.GET(new Request("http://x/api?repo=proj"), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ exists: true, branch: "main", dirty: 2, head: HEAD, commits: [HEAD] });
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
    expect(agent.calls).toEqual([{ method: "git-commit", repo: "proj", message: "fix typo", authorName: "Ed Itor", authorEmail: "editor@example.com" }]);
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
      env: { AINIZE_DECIDE_URL: "https://ainize.example.test/api/decide" },
      timeoutMs: 120000,
    });
    // .git is hidden by the agent; node_modules was never listed into.
    expect(agent.calls.filter((c) => c.method === "list").map((c) => c.path)).toEqual(["proj", "proj/lib"]);
  });

  it("forwards the person's answers to the manifest's inputs as env (INPUT_<NAME> first, the decide URL ours); refuses bad env", async () => {
    await as("vw1");
    const fetchMock = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await runRoute.POST(post("http://x/api", { repo: "proj", entry: "main.py", env: { INPUT_DESC: "해질녘 바다", INPUT_TOP_K: 5, INPUT_DRY: true, AINIZE_DECIDE_URL: "https://evil" } }), ctx);
    expect(res.status).toBe(200);
    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.env).toEqual({ INPUT_DESC: "해질녘 바다", INPUT_TOP_K: "5", INPUT_DRY: "true", AINIZE_DECIDE_URL: "https://ainize.example.test/api/decide" });
    for (const env of [{ "bad-name": "x" }, { A: "x".repeat(2049) }, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`I${i}`, "v"])), [1], "x", { A: { nested: 1 } }]) {
      const bad = await runRoute.POST(post("http://x/api", { repo: "proj", entry: "main.py", env }), ctx);
      expect(bad.status, JSON.stringify(env).slice(0, 40)).toBe(400);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
