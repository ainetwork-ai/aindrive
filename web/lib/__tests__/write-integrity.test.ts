// Plan 12.3 (ain-integration): two writers saving one file at once.
//  - fs/write and MCP write_file run one write of a path at a time, so an
//    agent that writes in place (older CLIs, phone agents) never gets two
//    overlapping writes that interleave into one corrupt file;
//  - a writer may name the revision it read (`baseRevision` / If-Match /
//    MCP `base_revision`) and gets 409 `conflict` instead of silently
//    overwriting someone else's save;
//  - new names with '\' are refused (the contract would give them the id of
//    another path); agent errors map to a status that says whose fault it is.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-write-integrity-"));
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

// An agent that writes IN PLACE in two steps (truncate, then the bytes after
// a pause) — what an old agent's writeFile does to a big file. Without the
// server's per-path lock two overlapping writes interleave.
type F = { content: string; mtimeMs: number };
const disk = new Map<string, F>();
let clock = 1_000;
const tick = () => new Promise((r) => setTimeout(r, 5));
vi.mock("../rpc", () => {
  class AgentError extends Error {
    status: number;
    constructor(msg: string, status = 502) { super(msg); this.status = status; }
  }
  return {
    AgentError,
    callAgent: async (_driveId: string, _s: string, req: Record<string, string>) => {
      switch (req.method) {
        case "stat": {
          const f = disk.get(req.path);
          return { entry: f ? { name: req.path, isDir: false, size: f.content.length, mtimeMs: f.mtimeMs } : null };
        }
        case "list": return { entries: [] };
        case "write": {
          const half = Math.floor(req.content.length / 2);
          const f: F = disk.get(req.path) ?? { content: "", mtimeMs: 0 };
          disk.set(req.path, f);
          f.content = req.content.slice(0, half); f.mtimeMs = ++clock;
          await tick();
          // Positional write of the rest at offset `half` (no truncate), as a second fd write does.
          const cur = f.content;
          f.content = cur.slice(0, half).padEnd(half, "\0") + req.content.slice(half) + cur.slice(req.content.length);
          f.mtimeMs = ++clock;
          return { method: "write", ok: true, bytes: req.content.length };
        }
        default: throw new AgentError(`unmocked ${req.method}`);
      }
    },
  };
});

const { db } = await import("../db.js");
const { sign } = await import("../session.js");
const guard = await import("../write-guard");
const { agentErrorStatus } = await import("../agents.js");
const writeRoute = await import("../../app/api/drives/[driveId]/fs/write/route.js");
const mkdirRoute = await import("../../app/api/drives/[driveId]/fs/mkdir/route.js");
const renameRoute = await import("../../app/api/drives/[driveId]/fs/rename/route.js");
const { runSkill } = await import("../../shared/agent-skills");

function write(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return writeRoute.POST(
    new Request("http://drive.test/api/drives/d1/fs/write", {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ driveId: "d1" }) },
  );
}
const post = (h: typeof mkdirRoute.POST, op: string, body: unknown) =>
  h(new Request(`http://drive.test/api/drives/d1/fs/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ driveId: "d1" }) });

beforeAll(() => {
  const u = db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)");
  u.run("owner1", "o@example.com", "Owner", "x");
  u.run("ed1", "e@example.com", "Editor", "x");
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)").run("d1", "owner1", "D", "h", "s");
  db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)").run("m1", "d1", "ed1", "", "editor");
});
beforeEach(async () => { cookieJar.clear(); cookieJar.set("aindrive_session", await sign("owner1")); });

describe("fs/write: overlapping writes of one path", () => {
  it("never leave a file made of both contents", async () => {
    for (let i = 0; i < 5; i++) {
      const a = `A${i}`.repeat(1000), b = `b${i}`.repeat(300);
      const [ra, rb] = await Promise.all([write({ path: "same.md", content: a }), write({ path: "same.md", content: b })]);
      expect([ra.status, rb.status]).toEqual([200, 200]);
      const got = disk.get("same.md")!.content;
      expect(got === a || got === b).toBe(true);
    }
  });

  it("answers the new revision", async () => {
    const r = await write({ path: "rev.md", content: "x" });
    const j = await r.json();
    expect(j.revision).toBe(guard.baseRevisionOf({ mtimeMs: disk.get("rev.md")!.mtimeMs, size: 1 }));
  });
});

describe("fs/write: conditional writes", () => {
  it("a stale baseRevision is 409 conflict with the current revision; the other save survives", async () => {
    const first = await (await write({ path: "c.md", content: "v1" })).json();
    const bob = await write({ path: "c.md", content: "bob", baseRevision: first.revision });
    expect(bob.status).toBe(200);
    const alice = await write({ path: "c.md", content: "alice", baseRevision: first.revision });
    expect(alice.status).toBe(409);
    const body = await alice.json();
    expect(body.error.code).toBe("conflict");
    expect(body.error.currentRevision).toBe((await bob.json()).revision);
    expect(disk.get("c.md")!.content).toBe("bob");
  });

  it("two writers holding the same revision at once: exactly one wins", async () => {
    const base = (await (await write({ path: "race.md", content: "base" })).json()).revision;
    const res = await Promise.all([
      write({ path: "race.md", content: "one".repeat(50), baseRevision: base }),
      write({ path: "race.md", content: "two".repeat(70), baseRevision: base }),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = res[0].status === 200 ? "one".repeat(50) : "two".repeat(70);
    expect(disk.get("race.md")!.content).toBe(winner);
  });

  it("accepts the listing's -g<gen> suffix, quotes and If-Match", async () => {
    const rev = (await (await write({ path: "h.md", content: "v1" })).json()).revision;
    expect((await write({ path: "h.md", content: "v2", baseRevision: `${rev}-g1a2b` })).status).toBe(200);
    expect((await write({ path: "h.md", content: "v3" }, { "if-match": `"${rev}"` })).status).toBe(409);
  });

  it("none / If-None-Match: * create only", async () => {
    expect((await write({ path: "new.md", content: "x", baseRevision: "none" })).status).toBe(200);
    expect((await write({ path: "new.md", content: "y", baseRevision: "none" })).status).toBe(409);
    expect((await write({ path: "new.md", content: "y" }, { "if-none-match": "*" })).status).toBe(409);
    expect(disk.get("new.md")!.content).toBe("x");
  });

  it("a revision for a missing file is a conflict, not a create", async () => {
    const r = await write({ path: "ghost.md", content: "x", baseRevision: "m1-s1" });
    expect(r.status).toBe(409);
    expect(disk.has("ghost.md")).toBe(false);
  });

  it("MCP write_file honours base_revision and the lock", async () => {
    const ctx = { userId: "ed1", scope: "write" as const };
    const first = await runSkill(ctx, "write_file", { drive_id: "d1", path: "m.md", content: "v1" });
    expect(first.kind).toBe("ok");
    const rev = (first as { structured: { revision: string } }).structured.revision;
    expect((await runSkill(ctx, "write_file", { drive_id: "d1", path: "m.md", content: "v2", base_revision: rev })).kind).toBe("ok");
    const stale = await runSkill(ctx, "write_file", { drive_id: "d1", path: "m.md", content: "v3", base_revision: rev });
    expect(stale.kind).toBe("err");
    expect((stale as { message: string }).message).toMatch(/^conflict/);
    expect(disk.get("m.md")!.content).toBe("v2");
  });
});

describe("names with a backslash", () => {
  it("are refused on write, mkdir and rename-to", async () => {
    expect((await write({ path: "back\\slash.txt", content: "x" })).status).toBe(400);
    expect((await post(mkdirRoute.POST, "mkdir", { path: "a\\b" })).status).toBe(400);
    expect((await post(renameRoute.POST, "rename", { from: "rev.md", to: "x\\y.md" })).status).toBe(400);
    expect(disk.has("back\\slash.txt")).toBe(false);
  });
});

describe("write-guard helpers", () => {
  it("expectedRevision: body wins, then If-None-Match, then If-Match", () => {
    const h = new Headers({ "if-match": 'W/"m5-s2-gff"' });
    expect(guard.expectedRevision(undefined, h)).toBe("m5-s2");
    expect(guard.expectedRevision("m9-s1", h)).toBe("m9-s1");
    expect(guard.expectedRevision("NONE", h)).toBe("none");
    expect(guard.expectedRevision(undefined, new Headers({ "if-none-match": "*" }))).toBe("none");
    expect(guard.expectedRevision(undefined, new Headers())).toBeNull();
    expect(guard.expectedRevision(undefined, new Headers({ "if-match": "*" }))).toBeNull();
  });

  it("conflictWith", () => {
    const f = { exists: true as const, isDir: false, revision: "m1-s1" };
    expect(guard.conflictWith(null, f)).toBeNull();
    expect(guard.conflictWith("m1-s1", f)).toBeNull();
    expect(guard.conflictWith("m2-s1", f)).toEqual({ currentRevision: "m1-s1" });
    expect(guard.conflictWith("none", { exists: false })).toBeNull();
    expect(guard.conflictWith("none", f)).toEqual({ currentRevision: "m1-s1" });
    expect(guard.conflictWith("m1-s1", { exists: false })).toEqual({ currentRevision: null });
  });

  it("withPathLock serializes one path, not others, and survives a throw", async () => {
    const order: string[] = [];
    const slow = (tag: string) => async () => { order.push(`${tag}+`); await tick(); order.push(`${tag}-`); };
    await Promise.all([
      guard.withPathLock("d", "p", slow("a")),
      guard.withPathLock("d", "p", async () => { throw new Error("boom"); }).catch(() => order.push("err")),
      guard.withPathLock("d", "p", slow("b")),
    ]);
    expect(order).toEqual(["a+", "a-", "err", "b+", "b-"]);
    const other: string[] = [];
    await Promise.all([
      guard.withPathLock("d", "x", async () => { other.push("x+"); await tick(); other.push("x-"); }),
      guard.withPathLock("d", "y", async () => { other.push("y+"); await tick(); other.push("y-"); }),
    ]);
    expect(other.slice(0, 2).sort()).toEqual(["x+", "y+"]);
  });
});

describe("agentErrorStatus", () => {
  it.each([
    ["ENOENT: no such file or directory, open '<path>a.md'", 404],
    ["ENAMETOOLONG: name too long, open '<path>x'", 400],
    ["path too long", 400],
    ["path escapes drive root", 400],
    ["reserved path", 400],
    ["EISDIR: illegal operation on a directory, read", 400],
    ["ENOSPC: no space left on device, write", 507],
    ["EACCES: permission denied", 502],
    ["agent error", 502],
  ])("%s → %i", (msg, status) => {
    expect(agentErrorStatus(msg)).toBe(status);
  });
});
