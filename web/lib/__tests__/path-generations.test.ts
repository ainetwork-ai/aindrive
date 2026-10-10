// Plan task 10.2: a FileRef minted for a path must never resolve to a different
// file later created at the same path. lib/path-generations.js hands out a
// per-path generation (fs/list `generation` + `revision`, shared-file refs'
// `revision` suffix); fs/read with a stale one answers 410 resource_deleted.
// Refs without a generation keep working, and nothing changes with
// AIN_INTEGRATION_ENABLED off.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-generations-"));
process.env.AINDRIVE_PUBLIC_URL = "https://drive.test";
delete process.env.AIN_INTEGRATION_ENABLED;

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

// A tiny device filesystem: path → { content, birth }. `birth` is what a real
// agent reports as birthtimeMs; 0 = the filesystem records none.
type Node = { content: string; birth: number };
const disk = new Map<string, Node>();
let clock = 1_000;
let reportBirth = true;
vi.mock("../rpc", () => {
  class AgentError extends Error {
    status: number;
    constructor(msg: string, status = 502) { super(msg); this.status = status; }
  }
  const entry = (p: string) => {
    const n = disk.get(p);
    const isDir = !n;
    return {
      name: p.split("/").pop()!, path: p, isDir, size: n ? n.content.length : 0, mtimeMs: 5_000,
      ...(reportBirth && n ? { birthtimeMs: n.birth } : {}), ext: "", mime: isDir ? "folder" : "text/markdown",
    };
  };
  const exists = (p: string) => disk.has(p) || [...disk.keys()].some((k) => k.startsWith(`${p}/`));
  return {
    AgentError,
    isOnline: () => true,
    callAgent: async (_d: string, _s: string, params: { method: string; path: string; content?: string; from?: string; to?: string }) => {
      switch (params.method) {
        case "list": {
          const prefix = params.path ? `${params.path}/` : "";
          const names = new Set<string>();
          for (const k of disk.keys()) if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split("/")[0]);
          return { method: "list", entries: [...names].sort().map((n) => entry(prefix + n)) };
        }
        case "stat": return { method: "stat", entry: exists(params.path) ? entry(params.path) : null };
        case "read": {
          const n = disk.get(params.path);
          if (!n) throw new AgentError("ENOENT: no such file or directory", 502);
          return { method: "read", content: n.content };
        }
        case "write": {
          const prev = disk.get(params.path);
          disk.set(params.path, { content: params.content ?? "", birth: prev?.birth ?? ++clock });
          return { method: "write", ok: true, bytes: (params.content ?? "").length };
        }
        case "delete": {
          for (const k of [...disk.keys()]) if (k === params.path || k.startsWith(`${params.path}/`)) disk.delete(k);
          return { method: "delete", ok: true };
        }
        case "rename": {
          const n = disk.get(params.from!);
          if (!n) throw new AgentError("ENOENT", 502);
          disk.delete(params.from!);
          disk.set(params.to!, n); // a rename keeps the file's birth time
          return { method: "rename", ok: true };
        }
      }
      throw new AgentError("unsupported", 400);
    },
  };
});

const { db } = await import("../db.js");
const { sign } = await import("../session.js");
const gens = await import("../path-generations.js");
const listRoute = await import("../../app/api/drives/[driveId]/fs/list/route.js");
const readRoute = await import("../../app/api/drives/[driveId]/fs/read/route.js");
const writeRoute = await import("../../app/api/drives/[driveId]/fs/write/route.js");
const deleteRoute = await import("../../app/api/drives/[driveId]/fs/delete/route.js");
const renameRoute = await import("../../app/api/drives/[driveId]/fs/rename/route.js");
const meRoute = await import("../../app/api/me/shared/route.js");

const ORIGIN = "https://drive.test";
const ctx = { params: Promise.resolve({ driveId: "d1" }) };

beforeAll(async () => {
  const u = db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)");
  for (const id of ["owner1", "reader1"]) u.run(id, `${id}@example.com`, id, "x");
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret, last_seen_at, created_at) VALUES (?,?,?,?,?,?,?)")
    .run("d1", "owner1", "Team Drive", "h", "s", "2026-09-28 10:00:00", "2026-09-01 00:00:00");
  db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role, created_at) VALUES (?,?,?,?,?,?)")
    .run("m1", "d1", "reader1", "docs/report.md", "viewer", "2026-09-10 00:00:00");
  disk.set("docs/report.md", { content: "v1 report", birth: ++clock });
  disk.set("docs/other.md", { content: "other", birth: ++clock });
});

afterEach(() => {
  delete process.env.AIN_INTEGRATION_ENABLED;
  reportBirth = true;
});

async function as(userId: string) {
  cookieJar.clear();
  cookieJar.set("aindrive_session", await sign(userId));
}
const flagOn = () => { process.env.AIN_INTEGRATION_ENABLED = "1"; };

type Entry = { name: string; generation?: string; revision?: string };
async function listDocs(): Promise<Record<string, Entry>> {
  const res = await listRoute.GET(new Request(`${ORIGIN}/api/drives/d1/fs/list?path=docs`), ctx);
  expect(res.status).toBe(200);
  const body = await res.json() as { entries: Entry[] };
  return Object.fromEntries(body.entries.map((e) => [e.name, e]));
}
async function read(path: string, q = "") {
  const res = await readRoute.GET(new Request(`${ORIGIN}/api/drives/d1/fs/read?path=${encodeURIComponent(path)}${q}`), ctx);
  return { status: res.status, body: await res.json() };
}
const post = (route: { POST: (r: Request, c: typeof ctx) => Promise<Response> }, name: string, body: unknown) =>
  route.POST(new Request(`${ORIGIN}/api/drives/d1/fs/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), ctx);

describe("10.2 with AIN_INTEGRATION_ENABLED off: nothing changes", () => {
  it("listings carry no generation, a generation parameter is ignored, and no row is handed out", async () => {
    await as("owner1");
    const docs = await listDocs();
    expect(docs["report.md"].generation).toBeUndefined();
    expect(docs["report.md"].revision).toBeUndefined();
    expect((await read("docs/report.md", "&generation=deadbeef00")).status).toBe(200);
    expect(gens.peekGeneration("d1", "docs/report.md")).toBeNull();
    const shared = await (await (async () => { await as("reader1"); return meRoute.GET(new Request(`${ORIGIN}/api/me/shared`)); })()).json();
    expect(shared.items[0].ref.revision).not.toMatch(/-g/);
  });
});

describe("10.2: a generation pins a ref to the file that was there", () => {
  it("listings carry a stable generation and a revision that ends with it", async () => {
    flagOn();
    await as("owner1");
    const a = await listDocs();
    const b = await listDocs();
    expect(a["report.md"].generation).toMatch(/^[0-9a-f]{16}$/);
    expect(a["report.md"].generation).toBe(b["report.md"].generation);
    expect(a["report.md"].generation).not.toBe(a["other.md"].generation);
    expect(a["report.md"].revision).toBe(`m5000-s9-g${a["report.md"].generation}`);
  });

  it("the current generation (or revision) reads; a ref without one reads as before", async () => {
    flagOn();
    await as("owner1");
    const { generation, revision } = (await listDocs())["report.md"];
    expect((await read("docs/report.md", `&generation=${generation}`)).body.content).toBe("v1 report");
    expect((await read("docs/report.md", `&revision=${revision}`)).body.content).toBe("v1 report");
    expect((await read("docs/report.md")).body.content).toBe("v1 report");
    // A revision from before generations (or another product's) carries none: no check.
    expect((await read("docs/report.md", "&revision=m5000-s9")).status).toBe(200);
    // A malformed generation is refused, not ignored.
    const bad = await read("docs/report.md", "&generation=NOT_A_GEN!");
    expect(bad.status).toBe(415);
    expect(bad.body.error.code).toBe("unsupported_input");
  });

  it("delete + re-create through aindrive: the old ref is resource_deleted, never the new file", async () => {
    flagOn();
    await as("owner1");
    const old = (await listDocs())["report.md"].generation!;
    expect((await post(deleteRoute, "delete", { path: "docs/report.md" })).status).toBe(200);
    // Gone: the old ref says so (410, not retryable).
    const gone = await read("docs/report.md", `&generation=${old}`);
    expect(gone.status).toBe(410);
    expect(gone.body.error).toMatchObject({ code: "resource_deleted", retryable: false });
    // Someone creates another file at the same path.
    expect((await post(writeRoute, "write", { path: "docs/report.md", content: "a different report" })).status).toBe(200);
    const stale = await read("docs/report.md", `&generation=${old}`);
    expect(stale.status).toBe(410);
    expect(JSON.stringify(stale.body)).not.toContain("a different report");
    // The listing hands out a new generation, which reads the new file.
    const fresh = (await listDocs())["report.md"].generation!;
    expect(fresh).not.toBe(old);
    expect((await read("docs/report.md", `&generation=${fresh}`)).body.content).toBe("a different report");
    // A path-only ref (no generation) keeps its old meaning: whatever is at the path.
    expect((await read("docs/report.md")).body.content).toBe("a different report");
    // An edit in place is the same file: its generation stays.
    expect((await post(writeRoute, "write", { path: "docs/report.md", content: "edited" })).status).toBe(200);
    expect((await listDocs())["report.md"].generation).toBe(fresh);
  });

  it("a rename: the old path's ref is gone, and a ref for the destination does not follow the moved file", async () => {
    flagOn();
    await as("owner1");
    disk.set("docs/draft.md", { content: "draft", birth: ++clock });
    disk.set("docs/final.md", { content: "old final", birth: ++clock });
    const before = await listDocs();
    expect((await post(renameRoute, "rename", { from: "docs/draft.md", to: "docs/final.md" })).status).toBe(200);
    expect((await read("docs/draft.md", `&generation=${before["draft.md"].generation}`)).status).toBe(410);
    expect((await read("docs/final.md", `&generation=${before["final.md"].generation}`)).status).toBe(410);
  });

  it("re-created on the owner's disk (no aindrive route saw it): a new birth time rotates the generation", async () => {
    flagOn();
    await as("owner1");
    disk.set("docs/photo.md", { content: "first", birth: ++clock });
    const old = (await listDocs())["photo.md"].generation!;
    disk.set("docs/photo.md", { content: "second", birth: ++clock }); // rm + create, faster than any watcher
    expect((await read("docs/photo.md", `&generation=${old}`)).status).toBe(410);
    expect((await listDocs())["photo.md"].generation).not.toBe(old);
    // The device's fs-changed frame for a removal drops the row (lib/agents.js → dropGenerations).
    const cur = (await listDocs())["photo.md"].generation!;
    gens.dropGenerations("d1", "docs/photo.md");
    expect((await read("docs/photo.md", `&generation=${cur}`)).status).toBe(410);
  });

  it("an agent that reports no birth time still keeps an unchanged file readable", async () => {
    flagOn();
    reportBirth = false;
    await as("owner1");
    const g = (await listDocs())["other.md"].generation!;
    expect((await read("docs/other.md", `&generation=${g}`)).status).toBe(200);
  });

  it("the shared-file list's ref carries the generation; its revision reads until the path holds another file", async () => {
    flagOn();
    await as("reader1");
    const list = await (await meRoute.GET(new Request(`${ORIGIN}/api/me/shared`))).json();
    const ref = list.items[0].ref;
    expect(ref.legacy.path).toBe("/docs/report.md");
    expect(ref.revision).toMatch(/^m\d+-s0-g[0-9a-f]{16}$/);
    const path = ref.legacy.path.slice(1);
    expect((await read(path, `&revision=${ref.revision}`)).status).toBe(200);
    // The same ref seen through fs/list has the same generation.
    await as("owner1");
    expect(ref.revision.endsWith(`-g${(await listDocs())["report.md"].generation}`)).toBe(true);
    await post(deleteRoute, "delete", { path });
    await post(writeRoute, "write", { path, content: "replacement" });
    await as("reader1");
    const r = await read(path, `&revision=${ref.revision}`);
    expect(r.status).toBe(410);
    expect(r.body.error.code).toBe("resource_deleted");
  });

  it("the stale check runs after the permission gate: a stranger learns nothing", async () => {
    flagOn();
    cookieJar.clear();
    const r = await read("docs/other.md", "&generation=0123456789abcdef");
    expect(r.status).toBe(401);
  });
});

describe("10.2: generation store", () => {
  it("dropGenerations clears a subtree (and only it); LIKE wildcards in names are literal", () => {
    for (const p of ["t/a", "t/a/b", "t/ab", "t/a%", "t/a%/x", "u/a"]) gens.generationFor("d9", p);
    gens.dropGenerations("d9", "t/a%");
    expect(["t/a", "t/a/b", "t/ab", "u/a"].every((p) => gens.peekGeneration("d9", p))).toBe(true);
    expect(gens.peekGeneration("d9", "t/a%/x")).toBeNull();
    gens.dropGenerations("d9", "t/a");
    expect(gens.peekGeneration("d9", "t/a")).toBeNull();
    expect(gens.peekGeneration("d9", "t/a/b")).toBeNull();
    expect(gens.peekGeneration("d9", "t/ab")).not.toBeNull();
    gens.dropGenerations("d9", "");
    expect(gens.peekGeneration("d9", "u/a")).toBeNull();
  });

  it("observeEntry never hands out a row, and rotates an existing one on a new birth time", () => {
    gens.observeEntry("d9", "x", { birthtimeMs: 10 });
    expect(gens.peekGeneration("d9", "x")).toBeNull();
    const g = gens.generationFor("d9", "x", { birthtimeMs: 10 });
    gens.observeEntry("d9", "x", { birthtimeMs: 10.4 });
    expect(gens.generationFor("d9", "x")).toBe(g);
    gens.observeEntry("d9", "x", { birthtimeMs: 99 });
    expect(gens.generationFor("d9", "x")).not.toBe(g);
  });

  it("revision helpers", () => {
    expect(gens.generationOfRevision(gens.revisionWithGeneration("m1-s2", "abcdef0123"))).toBe("abcdef0123");
    expect(gens.generationOfRevision("m1-s2")).toBeNull();
    expect(gens.generationOfRevision(undefined)).toBeNull();
  });
});
