import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-leave-"));

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

const { db } = await import("../db.js");
const { sign } = await import("../session.js");
const { POST: leave } = await import("../../app/api/drives/[driveId]/leave/route.js");

const ctx = { params: Promise.resolve({ driveId: "d1" }) };
const req = () => new Request("http://x/api", { method: "POST" });

beforeAll(async () => {
  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
    .run("owner1", "o@example.com", "Owner", "x");
  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
    .run("member1", "m@example.com", "Member", "x");
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)")
    .run("d1", "owner1", "D1", "h", "s");
  // member1 holds a root role AND a path-scoped grant — leave must drop both.
  db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)")
    .run("m1", "d1", "member1", "", "viewer");
  db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)")
    .run("m2", "d1", "member1", "docs", "editor");
});

describe("drive leave", () => {
  it("removes every membership row, including path-scoped grants", async () => {
    cookieJar.set("aindrive_session", await sign("member1"));
    const res = await leave(req(), ctx);
    expect(res.status).toBe(200);
    const rows = db.prepare("SELECT id FROM drive_members WHERE drive_id='d1' AND user_id='member1'").all();
    expect(rows).toEqual([]);
  });

  it("404s when not (or no longer) a member", async () => {
    cookieJar.set("aindrive_session", await sign("member1"));
    expect((await leave(req(), ctx)).status).toBe(404);
  });

  it("the creator cannot leave their own drive", async () => {
    cookieJar.set("aindrive_session", await sign("owner1"));
    const res = await leave(req(), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/creator/);
  });

  it("requires auth", async () => {
    cookieJar.clear();
    expect((await leave(req(), ctx)).status).toBe(401);
  });
});
