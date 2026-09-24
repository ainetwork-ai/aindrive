// The per-owner file cap: resolved from the drive OWNER's account (never the
// request's wallet cookie) for session, drive-PAT and account-token writes; the
// owner usage counter moves both ways.
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
const { signWallet, linkWalletToAccount } = await import("../wallet");
const { addLift } = await import("../paid-lifts.js");
const { bumpOwnerUsage, getOwnerUsage } = await import("../storage-usage.js");
const { getOwnerStorageCaps, TIER_FILE_LIMIT } = await import("../tier");
const tokens = await import("../mcp-tokens");
const oauth = await import("../oauth");
const acct = await import("../account-tokens");
const mcpRoute = await import("../../app/mcp/d/[driveId]/route.js");
const writeRoute = await import("../../app/api/drives/[driveId]/fs/write/route.js");
const renameRoute = await import("../../app/api/drives/[driveId]/fs/rename/route.js");
const deleteRoute = await import("../../app/api/drives/[driveId]/fs/delete/route.js");

const FREE_CAP = TIER_FILE_LIMIT.free;
const PRO_WALLET = "0x00000000000000000000000000000000000000a1";
const EDITOR_MAX_WALLET = "0x00000000000000000000000000000000000000b2";
const DAY = 24 * 60 * 60 * 1000;

let clientId = "";
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

const accountToken = (userId: string) =>
  acct.issueAccountTokens({ userId, clientId, clientName: "Afan", scopes: oauth.parseAccountScopes("drives:read drives:write") }).access_token;

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

beforeAll(async () => {
  const u = db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)");
  u.run("free1", "free@example.com", "Free owner", "x");
  u.run("pro1", "pro@example.com", "Pro owner", "x");
  u.run("editor1", "ed@example.com", "Editor", "x");
  const d = db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)");
  d.run("dfree", "free1", "Free", "h", "s");
  d.run("dpro", "pro1", "Pro", "h", "s");
  db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)")
    .run("m1", "dfree", "editor1", "", "editor");

  // pro1's Pro lift was bought by a wallet linked to the account.
  linkWalletToAccount("pro1", PRO_WALLET, "siwe");
  addLift({ wallet: PRO_WALLET, scope: "tier:pro", ttlMs: 30 * DAY, paymentTx: "0xtx-pro" });
  // editor1 holds Max — which must never lift someone else's drive's cap.
  linkWalletToAccount("editor1", EDITOR_MAX_WALLET, "siwe");
  addLift({ wallet: EDITOR_MAX_WALLET, scope: "tier:max", ttlMs: 30 * DAY, paymentTx: "0xtx-max" });

  clientId = oauth.registerClient("Afan", ["https://afan.example/cb"]).client_id;
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

describe("file cap is the drive owner's, whoever calls", () => {
  it("drive PAT: a Pro owner writes past the free cap though the call carries no wallet cookie", async () => {
    setFiles("pro1", FREE_CAP);
    expect(getOwnerStorageCaps("pro1")).toMatchObject({ tier: "pro", fileLimit: TIER_FILE_LIMIT.pro });
    expect(await writeFile("dpro", pat("pro1", "dpro"), fresh())).toBe("");
    expect(getOwnerUsage("pro1").files).toBe(FREE_CAP + 1);
  });

  it("account token: a Pro owner writes past the free cap", async () => {
    setFiles("pro1", FREE_CAP + 5);
    expect(await writeFile("dpro", accountToken("pro1"), fresh())).toBe("");
    expect(getOwnerUsage("pro1").files).toBe(FREE_CAP + 6);
  });

  it("drive PAT: a free owner at the cap gets file_limit_reached, even beside a Max wallet cookie", async () => {
    cookieJar.set("aindrive_wallet", await signWallet(EDITOR_MAX_WALLET));
    setFiles("free1", FREE_CAP - 1);
    const t = pat("free1", "dfree");
    expect(await writeFile("dfree", t, fresh())).toBe(""); // the 1000th file fits
    const err = await writeFile("dfree", t, fresh());
    expect(err).toContain("file_limit_reached");
    expect(err).toContain(`tier free, limit ${FREE_CAP}`);
    expect(getOwnerUsage("free1").files).toBe(FREE_CAP);
    // Overwriting an existing file at the cap is still fine.
    const existing = fresh();
    diskOf("dfree").set(existing, "file");
    expect(await writeFile("dfree", t, existing)).toBe("");
  });

  it("account token: a Max-tier editor can't lift a free owner's cap", async () => {
    setFiles("free1", FREE_CAP);
    const err = await writeFile("dfree", accountToken("editor1"), fresh());
    expect(err).toContain("file_limit_reached");
    expect(err).toContain("tier free");
  });

  it("session: fs/write measures the owner's tier, not the caller's wallet cookie", async () => {
    setFiles("free1", FREE_CAP);
    cookieJar.set("aindrive_session", await sign("editor1"));
    cookieJar.set("aindrive_wallet", await signWallet(EDITOR_MAX_WALLET));
    const res = await route(writeRoute.POST, "dfree", "write", { path: fresh(), content: "x" });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "file_limit_reached", tier: "free", limit: FREE_CAP });

    // And a Pro owner writing in a browser with no wallet cookie keeps Pro.
    cookieJar.clear();
    cookieJar.set("aindrive_session", await sign("pro1"));
    setFiles("pro1", FREE_CAP);
    expect((await route(writeRoute.POST, "dpro", "write", { path: fresh(), content: "x" })).status).toBe(200);
  });
});
