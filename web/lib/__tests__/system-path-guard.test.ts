// The reserved `.aindrive/` subtree (agent token, drive secret, agent API
// keys) must be unreachable through every user-facing drive path: fs/* routes
// (via requireDriveRole), JSON-body paths (zPath), rename destinations, and
// runSkill (MCP/A2A). The CLI agent is replaced by a recording stub.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-syspath-"));

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

const calls: Array<Record<string, unknown>> = [];
vi.mock("../rpc", () => ({
  AgentError: class extends Error {},
  callAgent: async (_d: string, _s: string, req: Record<string, unknown>) => {
    calls.push(req);
    if (req.method === "list") return { entries: [] };
    return { ok: true, content: "x" };
  },
}));

const { db } = await import("../db.js");
const { sign } = await import("../session.js");
const { zPath } = await import("../zod-helpers");
const { runSkill } = await import("../../shared/agent-skills");
const readRoute = await import("../../app/api/drives/[driveId]/fs/read/route.js");
const writeRoute = await import("../../app/api/drives/[driveId]/fs/write/route.js");
const renameRoute = await import("../../app/api/drives/[driveId]/fs/rename/route.js");

const ctx = { params: Promise.resolve({ driveId: "d1" }) };
const post = (body: unknown) =>
  new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(() => {
  const u = db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)");
  u.run("owner1", "o@example.com", "Owner", "x");
  u.run("ed1", "e@example.com", "Scoped editor", "x");
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)")
    .run("d1", "owner1", "D1", "h", "s");
  db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)")
    .run("m1", "d1", "ed1", "docs", "editor");
});

beforeEach(() => { calls.length = 0; });

describe(".aindrive is unreachable", () => {
  it("fs/read refuses it for the owner, however the path is spelled", async () => {
    cookieJar.set("aindrive_session", await sign("owner1"));
    for (const p of [".aindrive/config.json", "/.aindrive/config.json", "./.aindrive//config.json", ".aindrive"]) {
      const res = await readRoute.GET(new Request(`http://x/api?path=${encodeURIComponent(p)}`), ctx);
      expect(res.status, p).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  it("zPath rejects it, so JSON-body routes 400 before touching the agent", async () => {
    expect(zPath.safeParse(".aindrive/config.json").success).toBe(false);
    expect(zPath.safeParse("/.aindrive").success).toBe(false);
    expect(zPath.safeParse("docs/.aindrive/x").success).toBe(true); // only reserved at root
    cookieJar.set("aindrive_session", await sign("owner1"));
    const w = await writeRoute.POST(post({ path: ".aindrive/config.json", content: "{}" }), ctx);
    expect(w.status).toBe(400);
    const r = await renameRoute.POST(post({ from: "a.txt", to: ".aindrive/config.json" }), ctx);
    expect(r.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("runSkill (MCP/A2A) refuses it", async () => {
    for (const p of [".aindrive/config.json", "/.aindrive/config.json"]) {
      const r = await runSkill({ userId: "owner1" }, "read_file", { drive_id: "d1", path: p });
      expect(r, p).toMatchObject({ kind: "err", code: "forbidden" });
    }
    expect(calls).toEqual([]);
  });
});

describe("rename destination is gated", () => {
  it("a path-scoped editor can't move files out of their subtree", async () => {
    cookieJar.set("aindrive_session", await sign("ed1"));
    const out = await renameRoute.POST(post({ from: "docs/a.txt", to: "public/a.txt" }), ctx);
    expect(out.status).toBe(403);
    expect(calls).toEqual([]);
    const inside = await renameRoute.POST(post({ from: "docs/a.txt", to: "docs/b.txt" }), ctx);
    expect(inside.status).toBe(200);
    // The destination stat is the file-count bookkeeping (a rename onto an
    // existing file frees its slot); it runs only after both gates pass.
    expect(calls).toEqual([
      { method: "stat", path: "docs/b.txt" },
      { method: "rename", from: "docs/a.txt", to: "docs/b.txt" },
    ]);
  });
});
