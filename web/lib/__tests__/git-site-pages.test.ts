// The GitHub-like repo pages (app/d/by-slug/[slug]/[...rest], the raw route, and
// the smart-HTTP route's raw branch) against the real slug resolver, gate and
// db, with the CLI agent replaced by a stub. The pretty URL names the working
// copy repositories/<repo> (lib/git-paths.ts).
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-git-pages-"));
process.env.AINDRIVE_SESSION_SECRET = "git-pages-test-secret-0123456789abcdef";
process.env.AINDRIVE_PUBLIC_URL = "https://drive.example.test";
const ISSUER = "https://sso.example.test";
process.env.AINDRIVE_SSO_ISSUER = ISSUER;
process.env.AINDRIVE_SSO_CLIENT_ID = "app_aindrive";

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
const OLD = "89abcdef0123456789abcdef0123456789abcdef";
const agent = { calls: [] as Call[], offline: false };
vi.mock("../rpc", () => ({
  AgentError: class extends Error { status: number; constructor(m: string, s = 502) { super(m); this.status = s; } },
  callAgent: async (_d: string, _s: string, req: Call) => {
    agent.calls.push(req);
    if (agent.offline) throw Object.assign(new Error("agent offline"), { status: 504 });
    if (req.repo !== WC && req.method !== "stat") return { method: "git-refs", exists: false };
    switch (req.method) {
      case "git-refs": return { method: "git-refs", exists: true, head: "main", headSha: HEAD, branches: [{ name: "main", sha: HEAD }, { name: "dev", sha: OLD }] };
      case "stat":
        if (req.path === `${WC}/art_search.py`) return { method: "stat", entry: { name: "art_search.py", path: req.path, isDir: false, size: 12, mtimeMs: 1, ext: "py", mime: "text/x-python" } };
        if (req.path === `${WC}/lib`) return { method: "stat", entry: { name: "lib", path: req.path, isDir: true, size: 0, mtimeMs: 1, ext: "", mime: "folder" } };
        return { method: "stat", entry: null };
      case "git-ls-tree":
        if (req.ref === "nope") throw new Error("unknown ref");
        if (req.path === "missing") throw new Error("no such path at ref");
        return { method: "git-ls-tree", sha: OLD, entries: [
          { name: "lib", type: "tree", mode: "040000", size: 0, lastCommit: { sha: OLD, subject: "add lib", author: "Ann", date: "2026-10-01T00:00:00Z" } },
          { name: "art_search.py", type: "blob", mode: "100644", size: 12, lastCommit: { sha: OLD, subject: "v1", author: "Ann", date: "2026-10-01T00:00:00Z" } },
        ] };
      case "git-show":
        if (req.path === "lib") throw new Error("is a directory");
        if (req.path === "logo.png") return { method: "git-show", sha: OLD, size: 4, content: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"), truncated: false };
        if (req.path === "Dockerfile") return { method: "git-show", sha: OLD, size: 5, content: Buffer.from("FROM x\n").toString("base64"), truncated: false };
        return { method: "git-show", sha: OLD, size: 12, content: Buffer.from("print('v1')\n").toString("base64"), truncated: false };
      case "git-log": return { method: "git-log", sha: OLD, commits: [
        { sha: HEAD, parents: [OLD], subject: "v2", author: "Ann", authorEmail: "a@x", date: "2026-10-02T00:00:00Z", body: "" },
        { sha: OLD, parents: [], subject: "v1", author: "Ann", authorEmail: "a@x", date: "2026-10-01T00:00:00Z", body: "first" },
      ] };
      case "git-commit-detail": return { method: "git-commit-detail", sha: HEAD, parents: [OLD], subject: "v2", author: "Ann", authorEmail: "a@x", date: "2026-10-02T00:00:00Z", body: "", files: [{ path: "art_search.py", additions: 2, deletions: 1 }], patch: "diff --git a/art_search.py b/art_search.py\n@@ -1 +1,2 @@\n-print('v1')\n+print('v2')\n+print('more')\n", truncated: false };
    }
    return { ok: true };
  },
}));

const { db } = await import("../db.js");
const { sign } = await import("../session.js");
const orgs = await import("../orgs.js");
const Page = (await import("../../app/d/by-slug/[slug]/[...rest]/page")).default;
const rawRoute = await import("../../app/d/by-slug/[slug]/[repo]/raw/[...rest]/route");
const slugRoute = await import("../../app/[slug]/git/[...path]/route");
const { DriveShell } = await import("../../components/drive-shell");

const as = async (userId: string | null) => { if (userId) cookieJar.set("aindrive_session", await sign(userId)); else cookieJar.delete("aindrive_session"); };
const page = (rest: string[], sp: Record<string, string> = {}) => Page({ params: Promise.resolve({ slug: "comcom", rest }), searchParams: Promise.resolve(sp) });
const html = async (rest: string[], sp?: Record<string, string>) => renderToStaticMarkup((await page(rest, sp)) as ReactElement);
const status = (e: unknown) => String((e as { digest?: string }).digest ?? (e as Error).message);

beforeAll(() => {
  const u = db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)");
  u.run("owner1", "o@example.com", "Owner", "x"); u.run("vw1", "v@example.com", "Viewer", "x"); u.run("nobody", "n@example.com", "Nobody", "x");
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)").run("d1", "owner1", "ComCom Drive", "h", "s");
  db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)").run("m1", "d1", "vw1", "", "viewer");
  db.prepare(
    `INSERT INTO sso_memberships (issuer, org_id, subject, user_id, org_slug, org_name, status, app_role, groups_json, applied_version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', 'member', '[]', 1, ?)`,
  ).run(ISSUER, "org_comcom", "acc_1", "owner1", "comcom", "ComCom", Date.now());
  orgs.shareDriveWithOrg({ driveId: "d1", issuer: ISSUER, orgId: "org_comcom", role: "viewer", actor: "operator", via: "operator" });
});
beforeEach(() => { agent.calls.length = 0; agent.offline = false; });

describe("resolution", () => {
  it("404s an unknown org, a git-client path, an unknown route, a non-repo folder and an unknown ref — before or without asking the agent", async () => {
    await as("vw1");
    await expect(Page({ params: Promise.resolve({ slug: "nobody-org", rest: ["clef"] }), searchParams: Promise.resolve({}) })).rejects.toSatisfy((e) => status(e).includes("404"));
    await expect(page(["clef", "info", "refs"])).rejects.toSatisfy((e) => status(e).includes("404"));
    await expect(page(["clef", "nope"])).rejects.toSatisfy((e) => status(e).includes("404"));
    expect(agent.calls).toEqual([]);
    await expect(page(["plain-folder"])).rejects.toSatisfy((e) => status(e).includes("404"));
    expect(agent.calls).toEqual([{ method: "git-refs", repo: "repositories/plain-folder" }]);
    await expect(page(["clef", "tree", "nope"])).rejects.toSatisfy((e) => status(e).includes("404"));
    await expect(page(["clef", "tree", "dev", "missing"])).rejects.toSatisfy((e) => status(e).includes("404"));
  });

  it("sends an anonymous browser to sign in and back to the pretty URL; a stranger sees no access", async () => {
    await as(null);
    await expect(page(["clef", "blob", "main", "art_search.py"])).rejects.toSatisfy((e) => status(e).includes("/login?next=%2Fcomcom%2Fgit%2Fclef%2Fblob%2Fmain%2Fart_search.py"));
    await as("nobody");
    expect(await html(["clef"])).toContain("No access to this repository");
    expect(agent.calls).toEqual([]); // the gate ran first
  });

  it("an offline agent is said so, not a 404", async () => {
    await as("vw1"); agent.offline = true;
    expect(await html(["clef"])).toContain("Drive offline");
  });
});

describe("the checked-out branch is the drive shell with pretty URLs", () => {
  it("repo root and tree/<default> render the shell at the working copy; blob opens the file from the working tree", async () => {
    await as("vw1");
    const root = (await page(["clef"])) as ReactElement;
    expect(root.type).toBe(DriveShell);
    expect(root.props).toMatchObject({ driveId: "d1", initialFolder: WC, scopeRoot: WC, initialOpen: null, git: { org: "comcom", repo: "clef", ref: "main", defaultBranch: "main", branches: ["main", "dev"] } });
    const sub = (await page(["clef", "tree", "main", "lib"])) as ReactElement;
    expect(sub.props).toMatchObject({ initialFolder: `${WC}/lib` });
    const blob = (await page(["clef", "blob", "main", "art_search.py"])) as ReactElement;
    expect(blob.type).toBe(DriveShell);
    expect(blob.props).toMatchObject({ initialFolder: WC, initialOpen: { path: `${WC}/art_search.py`, isDir: false } });
    // blob of a folder → its tree URL; blob of nothing → 404
    await expect(page(["clef", "blob", "main", "lib"])).rejects.toSatisfy((e) => status(e).includes("/comcom/git/clef/tree/main/lib"));
    await expect(page(["clef", "blob", "main", "ghost.py"])).rejects.toSatisfy((e) => status(e).includes("404"));
    // no object-store read happened for the working tree
    expect(agent.calls.map((c) => c.method)).not.toContain("git-ls-tree");
  });
});

describe("other refs are read-only pages from the object store", () => {
  it("tree at a branch: breadcrumb, ref switcher, read-only banner, rows linking to blob/tree URLs and last commits", async () => {
    await as("vw1");
    const out = await html(["clef", "tree", "dev"]);
    expect(out).toContain('data-testid="read-only-banner"');
    expect(out).toContain("viewing <span");
    expect(out).toContain('href="/comcom/git/clef/tree/dev/lib"');
    expect(out).toContain('href="/comcom/git/clef/blob/dev/art_search.py"');
    expect(out).toContain(`href="/comcom/git/clef/commit/${OLD}"`);
    expect(out).toContain('href="/d/d1"'); // the org crumb leaves for the drive
    expect(out).toContain('data-testid="ref-switcher"');
    expect(agent.calls).toContainEqual({ method: "git-ls-tree", repo: WC, ref: "dev", path: "" });
  });

  it("blob at a branch: text with line numbers and Raw / History; an image inline; a Dockerfile is text", async () => {
    await as("vw1");
    const py = await html(["clef", "blob", "dev", "art_search.py"]);
    expect(py).toContain("print(&#x27;v1&#x27;)");
    expect(py).toContain('href="/comcom/git/clef/raw/dev/art_search.py"');
    expect(py).toContain('href="/comcom/git/clef/commits/dev?path=art_search.py"');
    const png = await html(["clef", "blob", "dev", "logo.png"]);
    expect(png).toContain('<img src="/comcom/git/clef/raw/dev/logo.png"');
    const docker = await html(["clef", "blob", "dev", "Dockerfile"]);
    expect(docker).toContain("FROM x");
    await expect(page(["clef", "blob", "dev", "lib"])).rejects.toSatisfy((e) => status(e).includes("/comcom/git/clef/tree/dev/lib"));
  });

  it("commits/<ref> lists the log (optionally one path's history) and commit/<sha> shows files, +/− and the patch", async () => {
    await as("vw1");
    const list = await html(["clef", "commits", "main"]);
    expect(list).toContain(`href="/comcom/git/clef/commit/${HEAD}"`);
    expect(list).toContain("v1");
    await html(["clef", "commits", "main"], { path: "art_search.py" });
    expect(agent.calls.filter((c) => c.method === "git-log").map((c) => c.path)).toEqual([undefined, "art_search.py"]);
    const detail = await html(["clef", "commit", HEAD]);
    expect(detail).toContain("1 changed file");
    expect(detail).toContain("+2");
    expect(detail).toContain("−1");
    expect(detail).toContain("+print(&#x27;v2&#x27;)");
    expect(agent.calls).toContainEqual({ method: "git-commit-detail", repo: WC, sha: HEAD });
  });

  it("deployments renders the full-page client view", async () => {
    await as("vw1");
    expect(await html(["clef", "deployments"])).toContain("Loading");
  });
});

describe("raw", () => {
  it("the raw route answers the bytes with a safe content type, 404 for a missing path, and refuses strangers", async () => {
    await as("vw1");
    const res = await rawRoute.GET(new Request("http://x/d/by-slug/comcom/clef/raw/dev/art_search.py"), { params: Promise.resolve({ slug: "comcom", repo: "clef", rest: ["dev", "art_search.py"] }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("print('v1')\n");
    const png = await rawRoute.GET(new Request("http://x/"), { params: Promise.resolve({ slug: "comcom", repo: "clef", rest: ["dev", "logo.png"] }) });
    expect(png.headers.get("content-type")).toBe("image/png");
    expect((await rawRoute.GET(new Request("http://x/"), { params: Promise.resolve({ slug: "comcom", repo: "clef", rest: ["dev", "lib"] }) })).status).toBe(404);
    await as("nobody");
    expect((await rawRoute.GET(new Request("http://x/"), { params: Promise.resolve({ slug: "comcom", repo: "clef", rest: ["dev", "art_search.py"] }) })).status).toBe(403);
  });

  it("a non-browser client (no text/html Accept) gets the same bytes through the smart-HTTP route; git paths still go to git", async () => {
    await as("vw1");
    const res = await slugRoute.GET(new Request("http://x/comcom/git/clef/raw/dev/art_search.py", { headers: { accept: "*/*" } }), { params: Promise.resolve({ slug: "comcom", path: ["clef", "raw", "dev", "art_search.py"] }) });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("print('v1')\n");
    agent.calls.length = 0;
    const refs = await slugRoute.GET(new Request("http://x/comcom/git/clef/info/refs?service=git-upload-pack", { headers: { accept: "*/*" } }), { params: Promise.resolve({ slug: "comcom", path: ["clef", "info", "refs"] }) });
    // the smart-HTTP path reaches git-http: the bare remote repositories/clef.git is asked first
    expect(agent.calls[0]).toMatchObject({ method: "git-advertise", repo: "repositories/clef.git", service: "upload-pack" });
    expect(refs.status).not.toBe(200); // the stub has no pack to serve; what matters is where the request went
  });
});
