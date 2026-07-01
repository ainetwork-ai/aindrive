// Locks the policy decision: folder creation is UNLIMITED for every tier.
//
// Folders (empty dirs) are cheap and were never intended as a paid boundary; the
// real resource guards are the file-count cap and rate limits (unchanged). This
// test drives the mkdir route with an owner already at the old free cap (100
// folders) and asserts it is NOT rejected — i.e. TIER_FOLDER_LIMIT is Infinity
// so the mkdir route's `Number.isFinite(folderLimit)` guard skips the check.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-folderlimit-"));

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

// The mkdir route calls the CLI agent over RPC after the limit check. No agent is
// connected in a unit test, so stub callAgent to a success — we are asserting the
// LIMIT behaviour (429 vs pass), not the filesystem effect.
vi.mock("../rpc.js", () => ({
  callAgent: async () => ({ method: "mkdir", ok: true }),
  AgentError: class AgentError extends Error { status?: number },
}));

const { db } = await import("../db.js");
const { sign } = await import("../session.js");
const { bumpOwnerUsage, getOwnerUsage } = await import("../storage-usage.js");
const { POST: mkdir } = await import("../../app/api/drives/[driveId]/fs/mkdir/route.js");

const ctx = { params: Promise.resolve({ driveId: "d1" }) };
const mkdirReq = (path: string) =>
  mkdir(new Request("http://localhost:3737/api/drives/d1/fs/mkdir", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }),
  }), ctx);

beforeAll(async () => {
  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
    .run("owner1", "o@example.com", "Owner", "x");
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)")
    .run("d1", "owner1", "D1", "h", "s");
  // Put the owner exactly at the OLD free cap (100 folders).
  bumpOwnerUsage("owner1", { folders: 100 });
  cookieJar.set("aindrive_session", await sign("owner1"));
});

describe("mkdir folder limit — unlimited for all tiers", () => {
  it("does NOT reject a free-tier owner already at the old 100-folder cap", async () => {
    const res = await mkdirReq("folder-101");
    expect(res.status).not.toBe(429);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
  });

  it("keeps creating far past the old cap (truly unlimited)", async () => {
    bumpOwnerUsage("owner1", { folders: 10_000 }); // now ~10k+ folders
    expect(getOwnerUsage("owner1").folders).toBeGreaterThan(10_000);
    const res = await mkdirReq("folder-way-past");
    expect(res.status).toBe(200);
  });
});
