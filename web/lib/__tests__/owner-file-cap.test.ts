// The per-owner usage counter moves both ways: a delete (or a rename onto an
// existing file) frees a slot; an overwrite never adds one.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-owner-cap-"));
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

// An in-memory agent disk per drive: path → "file" | "dir". Enough of the
// CLI's RPC surface for write/delete/rename/stat/list to behave for real.
const disks = new Map<string, Map<string, "file" | "dir">>();
const diskOf = (driveId: string) => {
  if (!disks.has(driveId)) disks.set(driveId, new Map());
  return disks.get(driveId)!;
};
const parentOf = (p: string) => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
vi.mock("../rpc", () => {
  class AgentError extends Error {
    status: number;
    constructor(msg: string, status = 502) { super(msg); this.status = status; }
  }
  return {
    AgentError,
    callAgent: async (driveId: string, _s: string, req: Record<string, string>) => {
      const disk = diskOf(driveId);
      switch (req.method) {
        case "list":
          return {
            entries: [...disk].filter(([p]) => parentOf(p) === req.path)
              .map(([p, k]) => ({ name: baseOf(p), isDir: k === "dir" })),
          };
        case "stat": {
          const k = disk.get(req.path);
          return { entry: k ? { name: baseOf(req.path), isDir: k === "dir" } : null };
        }
        case "write": disk.set(req.path, "file"); return { ok: true, bytes: 1 };
        case "mkdir": disk.set(req.path, "dir"); return { ok: true };
        case "delete":
          for (const p of [...disk.keys()]) if (p === req.path || p.startsWith(`${req.path}/`)) disk.delete(p);
          return { ok: true };
        case "rename": {
          const k = disk.get(req.from);
          if (!k) throw new AgentError("ENOENT", 404);
          disk.delete(req.from);
          disk.set(req.to, k);
          return { ok: true };
        }
        default: throw new AgentError(`unmocked ${req.method}`);
      }
    },
  };
});

const { db } = await import("../db.js");
const { sign } = await import("../session.js");
const { bumpOwnerUsage, getOwnerUsage } = await import("../storage-usage.js");
const tokens = await import("../mcp-tokens");
const mcpRoute = await import("../../app/mcp/d/[driveId]/route.js");
const writeRoute = await import("../../app/api/drives/[driveId]/fs/write/route.js");
const renameRoute = await import("../../app/api/drives/[driveId]/fs/rename/route.js");
const deleteRoute = await import("../../app/api/drives/[driveId]/fs/delete/route.js");


let seq = 0;
const fresh = (prefix = "f") => `${prefix}-${++seq}.txt`;

function mcp(driveId: string, token: string, name: string, args: Record<string, unknown>) {
  return mcpRoute.POST(
    new Request(`http://drive.test/mcp/d/${driveId}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    { params: Promise.resolve({ driveId }) },
  );
}

/** tools/call → the MCP result; "" when it succeeded, else the error text. */
async function callErr(driveId: string, token: string, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await mcp(driveId, token, name, args);
  expect(res.status).toBe(200);
  const text = await res.text();
  const data = text.includes("data:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text;
  const result = JSON.parse(data).result;
  return result.isError ? result.content[0].text : "";
}

const writeFile = (driveId: string, token: string, path: string) =>
  callErr(driveId, token, "write_file", { path, content: "x" });

const pat = (userId: string, driveId: string) =>
  tokens.issuePat({ userId, driveId, name: "t", scope: "write", ttlDays: null }).token;

function route(handler: (req: Request, ctx: { params: Promise<{ driveId: string }> }) => Promise<Response>, driveId: string, op: string, body: unknown) {
  return handler(
    new Request(`http://drive.test/api/drives/${driveId}/fs/${op}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ driveId }) },
  );
}

/** Put `ownerId`'s counter at exactly `n` files. */
function setFiles(ownerId: string, n: number) {
  bumpOwnerUsage(ownerId, { files: n - getOwnerUsage(ownerId).files });
  expect(getOwnerUsage(ownerId).files).toBe(n);
}

beforeAll(() => {
  const u = db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)");
  u.run("free1", "free@example.com", "Free owner", "x");
  const d = db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)");
  d.run("dfree", "free1", "Free", "h", "s");
});

beforeEach(() => { cookieJar.clear(); });

describe("owner usage counter", () => {
  it("applies negative deltas and clamps the stored total at 0", () => {
    bumpOwnerUsage("counter-a", { files: 5, folders: 2 });
    bumpOwnerUsage("counter-a", { files: -2, folders: -1 });
    expect(getOwnerUsage("counter-a")).toEqual({ files: 3, folders: 1 });
    bumpOwnerUsage("counter-a", { files: -10 });
    expect(getOwnerUsage("counter-a")).toEqual({ files: 0, folders: 1 });
    bumpOwnerUsage("counter-a", { files: 1 });
    expect(getOwnerUsage("counter-a").files).toBe(1);
    // First-ever row from a delete starts at 0, not negative.
    bumpOwnerUsage("counter-b", { files: -1 });
    expect(getOwnerUsage("counter-b")).toEqual({ files: 0, folders: 0 });
  });

  it("MCP delete_path of a file frees its slot; overwrite does not double count", async () => {
    const t = pat("free1", "dfree");
    setFiles("free1", 10);
    const path = fresh("docs/a");
    expect(await writeFile("dfree", t, path)).toBe("");
    expect(getOwnerUsage("free1").files).toBe(11);
    expect(await writeFile("dfree", t, path)).toBe(""); // overwrite
    expect(getOwnerUsage("free1").files).toBe(11);
    expect(await callErr("dfree", t, "delete_path", { path })).toBe("");
    expect(getOwnerUsage("free1").files).toBe(10);
  });

  it("fs/delete of a file decrements (session caller)", async () => {
    cookieJar.set("aindrive_session", await sign("free1"));
    setFiles("free1", 10);
    const path = fresh();
    expect((await route(writeRoute.POST, "dfree", "write", { path, content: "x" })).status).toBe(200);
    expect(getOwnerUsage("free1").files).toBe(11);
    expect((await route(deleteRoute.POST, "dfree", "delete", { path })).status).toBe(200);
    expect(getOwnerUsage("free1").files).toBe(10);
  });

  it("a rename never adds; a rename onto an existing file frees the replaced one", async () => {
    cookieJar.set("aindrive_session", await sign("free1"));
    const [a, b, c] = [fresh(), fresh(), fresh()];
    diskOf("dfree").set(a, "file");
    diskOf("dfree").set(b, "file");
    setFiles("free1", 10);
    expect((await route(renameRoute.POST, "dfree", "rename", { from: a, to: c })).status).toBe(200);
    expect(getOwnerUsage("free1").files).toBe(10);
    expect((await route(renameRoute.POST, "dfree", "rename", { from: c, to: b })).status).toBe(200);
    expect(diskOf("dfree").has(c)).toBe(false);
    expect(getOwnerUsage("free1").files).toBe(9);
  });
});
