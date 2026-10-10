// ainize Projects bound to a repo folder: the git-connect route (editor stores
// the one-time webhookSecret, viewer may not), the sealed store, pkt-line
// parsing of a push, and the signed hook call lib/git-http.ts fires after a
// successful receive-pack — against a fake ainize and a stub agent. Plus
// git-meta's manifest / default-entry / projectId additions.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-githooks-"));
process.env.AINDRIVE_SESSION_SECRET = "git-hooks-test-secret-0123456789abcdef";
process.env.AINDRIVE_PUBLIC_URL = "https://drive.example.test";
process.env.AINIZE_URL = "https://ainize.example.test";

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({
    get: (name: string) => { const v = cookieJar.get(name); return v === undefined ? undefined : { name, value: v }; },
    set: (name: string, value: string) => { cookieJar.set(name, value); },
    delete: (name: string) => { cookieJar.delete(name); },
  }),
}));

type Call = Record<string, unknown>;
const agent = { calls: [] as Call[], files: {} as Record<string, string>, root: [] as string[] };
vi.mock("../rpc", () => ({
  AgentError: class extends Error { status: number; constructor(m: string, s = 502) { super(m); this.status = s; } },
  callAgent: async (_d: string, _s: string, req: Call) => {
    agent.calls.push(req);
    switch (req.method) {
      case "git-advertise": return { method: "git-advertise", exists: true, data: "" };
      case "upload-chunk": return { method: "upload-chunk", ok: true, receivedBytes: 1 };
      case "git-service": return { method: "git-service", ok: true, size: 4 };
      case "download-chunk": return { method: "download-chunk", data: Buffer.from("0000").toString("base64"), eof: true };
      case "delete": return { method: "delete", ok: true };
      case "git-meta": return { method: "git-meta", exists: true, branch: "main", head: null, dirty: 0, commits: [] };
      case "read": {
        const c = agent.files[String(req.path)];
        if (c === undefined) throw new Error("ENOENT");
        return { method: "read", content: c, encoding: "utf8" };
      }
      case "list": return { entries: agent.root.map((n) => ({ name: n, path: `proj/${n}`, isDir: false, size: 1 })) };
    }
    return { ok: true };
  },
}));

const { db } = await import("../db.js");
const { sign } = await import("../session.js");
const hooks = await import("../git-project-hooks");
const connectRoute = await import("../../app/api/drives/[driveId]/git-connect/route");
const metaRoute = await import("../../app/api/drives/[driveId]/git-meta/route");
const { gitHttpPOST } = await import("../git-http");

const ctx = { params: Promise.resolve({ driveId: "d1" }) };
const post = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const as = async (userId: string | null) => { if (userId) cookieJar.set("aindrive_session", await sign(userId)); else cookieJar.delete("aindrive_session"); };

const OLD = "0".repeat(40), NEW = "a".repeat(40);
function pushBody(ref = "refs/heads/main") {
  const cmd = `${OLD} ${NEW} ${ref}\0report-status\n`;
  const pkt = (Buffer.byteLength(cmd) + 4).toString(16).padStart(4, "0") + cmd;
  return Buffer.concat([Buffer.from(pkt), Buffer.from("0000"), Buffer.from("PACKfake")]);
}

beforeAll(() => {
  const u = db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)");
  u.run("owner1", "o@example.com", "Owner", "x");
  u.run("ed1", "editor@example.com", "Ed Itor", "x");
  u.run("vw1", "v@example.com", "Viewer", "x");
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)").run("d1", "owner1", "D1", "h", "s");
  const m = db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)");
  m.run("m1", "d1", "ed1", "", "editor");
  m.run("m2", "d1", "vw1", "", "viewer");
  db.prepare("INSERT INTO sso_identities (issuer, subject, user_id, link_method, linked_at) VALUES (?,?,?,?,?)")
    .run("https://sso.example.test", "acc_ed", "ed1", "test", Date.now());
});
beforeEach(() => { agent.calls.length = 0; agent.files = {}; agent.root = []; db.prepare("DELETE FROM git_project_hooks").run(); db.prepare("DELETE FROM git_project_deliveries").run(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("POST git-connect", () => {
  it("an editor binds the repo to a project; the secret is sealed at rest and readable only in-process", async () => {
    await as("ed1");
    const res = await connectRoute.POST(post("http://x/api", { repo: "proj", projectId: "prj_1", webhookSecret: "whsec_topsecret" }), ctx);
    expect(res.status).toBe(200);
    const row = db.prepare("SELECT * FROM git_project_hooks WHERE drive_id='d1' AND repo='proj'").get() as Record<string, string>;
    expect(row.project_id).toBe("prj_1");
    expect(row.secret_enc).not.toContain("topsecret");
    expect(row.created_by).toBe("ed1");
    expect(hooks.projectHookFor("d1", "proj")).toEqual({ projectId: "prj_1", secret: "whsec_topsecret" });
    // GET shows the id (viewer), never the secret; rebind replaces.
    await as("vw1");
    expect(await (await connectRoute.GET(new Request("http://x/api?repo=proj"), ctx)).json()).toEqual({ projectId: "prj_1" });
    await as("owner1");
    await connectRoute.POST(post("http://x/api", { repo: "proj", projectId: "prj_2", webhookSecret: "whsec_other___" }), ctx);
    expect(hooks.projectHookFor("d1", "proj")).toEqual({ projectId: "prj_2", secret: "whsec_other___" });
  });

  it("a viewer cannot bind or unbind; bad bodies are 400", async () => {
    await as("vw1");
    expect((await connectRoute.POST(post("http://x/api", { repo: "proj", projectId: "p", webhookSecret: "whsec_topsecret" }), ctx)).status).toBe(403);
    expect((await connectRoute.DELETE(new Request("http://x/api?repo=proj", { method: "DELETE" }), ctx)).status).toBe(403);
    await as("ed1");
    expect((await connectRoute.POST(post("http://x/api", { repo: "proj", projectId: "p" }), ctx)).status).toBe(400);
    expect(hooks.projectIdFor("d1", "proj")).toBeNull();
  });
});

describe("parseReceivePackRefs", () => {
  it("reads every ref update before the flush and stops at the pack", () => {
    const pkt = (line: string) => Buffer.from((Buffer.byteLength(line) + 4).toString(16).padStart(4, "0") + line);
    const two = Buffer.concat([
      pkt(`${OLD} ${NEW} refs/heads/main\0report-status`),
      pkt(`${NEW} ${OLD} refs/heads/dev\n`),
      Buffer.from("0000PACK..."),
    ]);
    expect(hooks.parseReceivePackRefs(two)).toEqual([
      { before: OLD, after: NEW, ref: "refs/heads/main" },
      { before: NEW, after: OLD, ref: "refs/heads/dev" },
    ]);
    expect(hooks.parseReceivePackRefs(Buffer.from("garbage"))).toEqual([]);
    expect(hooks.parseReceivePackRefs(Buffer.alloc(0))).toEqual([]);
  });
});

describe("push → project hook", () => {
  it("a successful receive-pack on a bound repo POSTs the signed hook with the pusher, without blocking the push", async () => {
    hooks.storeProjectHook("d1", "proj", "prj_1", "whsec_topsecret", "ed1");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ deploymentId: "dep_1", status: "queued" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const jwt = await sign("ed1");
    const req = new Request("http://x/api/drives/d1/git/proj/git-receive-pack", {
      method: "POST", headers: { authorization: `Bearer ${jwt}`, "content-type": "application/x-git-receive-pack-request" },
      body: pushBody(), // @ts-expect-error duplex is required by undici for a streamed body
      duplex: "half",
    });
    const res = await gitHttpPOST("d1", ["proj", "git-receive-pack"], req);
    expect(res.status).toBe(200);
    await res.text();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ainize.example.test/api/projects/prj_1/hook");
    const body = init.body as string;
    expect(JSON.parse(body)).toMatchObject({ ref: "refs/heads/main", before: OLD, after: NEW, pusher: { subject: "acc_ed", email: "editor@example.com" } });
    const sig = (init.headers as Record<string, string>)["X-Ainize-Signature"];
    expect(sig).toBe("sha256=" + createHmac("sha256", "whsec_topsecret").update(body).digest("hex"));
  });

  it("an unbound repo fires nothing; a refused or dead hook is only logged", async () => {
    const fetchMock = vi.fn(async () => new Response("x", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await hooks.notifyProjectOfPush("d1", "proj", pushBody(), "ed1", fetchMock as unknown as typeof fetch)).toEqual([]);
    hooks.storeProjectHook("d1", "proj", "prj_1", "whsec_topsecret", "ed1");
    expect(await hooks.notifyProjectOfPush("d1", "proj", pushBody(), "ed1", fetchMock as unknown as typeof fetch)).toEqual([401]);
    const dead = vi.fn(async () => { throw new TypeError("fetch failed"); });
    expect(await hooks.notifyProjectOfPush("d1", "proj", pushBody(), "ed1", dead as unknown as typeof fetch)).toEqual([0]);
    const [, init] = dead.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).pusher).toEqual({ subject: "acc_ed", email: "editor@example.com" });
  });
});

describe("GET git-meta: manifest, entry, projectId", () => {
  it("exposes the manifest's inputs (workflow_dispatch shape) for the Run panel", async () => {
    await as("vw1");
    agent.files["proj/ainize.json"] = JSON.stringify({ kind: "script", entry: "a.py", inputs: {
      DESC: { description: "작품 묘사 (description)", type: "string", required: true, default: "해질녘 바다" },
      MODEL: { description: "모델", type: "choice", options: ["clef-flash", "clef"], default: "clef-flash" },
      top_k: { type: "number", default: 5 },
      dry: { type: "boolean" },
      "bad-name": {},
      NOOPTS: { type: "choice" },
    } });
    const body = await (await metaRoute.GET(new Request("http://x/api?repo=proj"), ctx)).json();
    expect(body.manifest.inputs).toEqual([
      { name: "DESC", description: "작품 묘사 (description)", type: "string", required: true, options: null, default: "해질녘 바다" },
      { name: "MODEL", description: "모델", type: "choice", required: false, options: ["clef-flash", "clef"], default: "clef-flash" },
      { name: "top_k", description: null, type: "number", required: false, options: null, default: "5" },
      { name: "dry", description: null, type: "boolean", required: false, options: null, default: null },
    ]);
  });

  it("reads ainize.json for entry/kind/name and the bound project id", async () => {
    await as("vw1");
    agent.files["proj/ainize.json"] = JSON.stringify({ name: "Clef search", kind: "script", entry: "src/app.py" });
    hooks.storeProjectHook("d1", "proj", "prj_9", "whsec_topsecret", "ed1");
    const body = await (await metaRoute.GET(new Request("http://x/api?repo=proj"), ctx)).json();
    expect(body.manifest).toEqual({ entry: "src/app.py", kind: "script", name: "Clef search", inputs: [] });
    expect(body.entry).toBe("src/app.py");
    expect(body.projectId).toBe("prj_9");
    expect(body.runnable).toEqual([]); // the root's runnable files are listed for the Run row's selector
  });

  it("falls back to the root's first runnable file (main.* first), null when none", async () => {
    await as("vw1");
    agent.root = ["README.md", "util.py", "main.py", "logo.png"];
    let body = await (await metaRoute.GET(new Request("http://x/api?repo=proj"), ctx)).json();
    expect(body.manifest).toBeNull();
    expect(body.entry).toBe("main.py");
    expect(body.runnable).toEqual(["main.py", "util.py"]);
    expect(body.projectId).toBeNull();
    agent.root = ["README.md"];
    agent.files["proj/ainize.json"] = "{ not json";
    body = await (await metaRoute.GET(new Request("http://x/api?repo=proj"), ctx)).json();
    expect(body.manifest).toBeNull();
    expect(body.entry).toBeNull();
  });
});


describe("durable project deliveries", () => {
  it("retries persisted requests with the same delivery id and captured actor after a worker restart", async () => {
    hooks.storeProjectHook("d1", "proj", "prj_1", "whsec_topsecret", "ed1");
    const failed = vi.fn(async () => new Response("offline", { status: 503 }));
    await hooks.notifyProjectOfPush("d1", "proj", pushBody(), "ed1", failed as typeof fetch);
    const { drainProjectDeliveries } = await import("../git-project-deliveries");
    const before = db.prepare("SELECT * FROM git_project_deliveries").get() as { id: string; status: string; payload: string };
    expect(before.status).toBe("pending");
    db.prepare("UPDATE users SET email = 'changed@example.com' WHERE id = 'ed1'").run();
    db.prepare("UPDATE git_project_deliveries SET next_attempt_at = 0").run();
    const sent: string[] = [];
    const success = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { sent.push(String(init?.body)); return new Response("ok", { status: 202 }); });
    await drainProjectDeliveries(success as typeof fetch);
    expect(JSON.parse(sent[0])).toMatchObject({ deliveryId: before.id, pusher: { subject: "acc_ed", email: "editor@example.com" } });
    const after = db.prepare("SELECT status, attempts FROM git_project_deliveries").get();
    expect(after).toEqual({ status: "delivered", attempts: 2 });
    await drainProjectDeliveries(success as typeof fetch);
    expect(success).toHaveBeenCalledTimes(1);
    db.prepare("UPDATE users SET email = 'editor@example.com' WHERE id = 'ed1'").run();
  });

  it("holds newer events until the older delivery succeeds and deduplicates repeated notifications", async () => {
    hooks.storeProjectHook("d1", "proj", "prj_1", "whsec_topsecret", "ed1");
    const { enqueueProjectDelivery, deliverProjectEvent } = await import("../git-project-deliveries");
    const first = { ref: "refs/heads/main", before: OLD, after: NEW };
    const second = { ref: "refs/heads/main", before: NEW, after: "b".repeat(40) };
    const actor = hooks.pusherOf("ed1");
    const a = enqueueProjectDelivery("d1", "proj", first, actor, "ed1");
    expect(enqueueProjectDelivery("d1", "proj", first, actor, "ed1")).toBe(a);
    const b = enqueueProjectDelivery("d1", "proj", second, actor, "ed1");
    const sent: string[] = [];
    const success = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { sent.push(JSON.parse(String(init?.body)).after); return new Response("ok", { status: 202 }); });
    expect(await deliverProjectEvent(b, success as typeof fetch, undefined, true)).toBeNull();
    const lease = db.prepare("UPDATE git_project_deliveries SET lease = 'dead-worker', lease_until = ? WHERE id = ?");
    lease.run(Date.now() + 60_000, a);
    expect(await deliverProjectEvent(a, success as typeof fetch, undefined, true)).toBeNull();
    lease.run(Date.now() - 1, a);
    expect(await deliverProjectEvent(a, success as typeof fetch, undefined, true)).toBe(202);
    expect(await deliverProjectEvent(b, success as typeof fetch, undefined, true)).toBe(202);
    expect(sent).toEqual([NEW, "b".repeat(40)]);
  });
});
