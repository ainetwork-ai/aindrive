import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-ownerroot-"));

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
const { POST: invite } = await import("../../app/api/drives/[driveId]/members/route.js");
const { PATCH: changeRole } = await import("../../app/api/drives/[driveId]/members/[memberId]/route.js");

const ctx = { params: Promise.resolve({ driveId: "d1" }) };
const memberCtx = (memberId: string) => ({ params: Promise.resolve({ driveId: "d1", memberId }) });

function inviteReq(body: object) {
  return invite(new Request("http://x/api", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), ctx);
}

beforeAll(async () => {
  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
    .run("owner1", "o@example.com", "Owner", "x");
  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
    .run("guest1", "g@example.com", "Guest", "x");
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)")
    .run("d1", "owner1", "D1", "h", "s");
  // guest1 already has a path-scoped editor grant we'll try to PATCH to owner.
  db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)")
    .run("m_guest_docs", "d1", "guest1", "docs", "editor");
  cookieJar.set("aindrive_session", await sign("owner1"));
});

describe("owner role is whole-drive only", () => {
  it("rejects inviting owner to a non-root path (400)", async () => {
    const res = await inviteReq({ email: "g@example.com", path: "docs", role: "owner" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/whole drive/);
  });

  it("allows inviting owner at the drive root", async () => {
    const res = await inviteReq({ email: "g@example.com", path: "", role: "owner" });
    expect(res.status).toBe(200);
    const row = db.prepare("SELECT role FROM drive_members WHERE drive_id='d1' AND user_id='guest1' AND path=''").get() as { role: string };
    expect(row.role).toBe("owner");
  });

  it("still allows editor/viewer at a non-root path", async () => {
    const res = await inviteReq({ email: "g@example.com", path: "media", role: "editor" });
    expect(res.status).toBe(200);
  });

  it("rejects PATCH promoting a path-scoped grant to owner (400)", async () => {
    const res = await changeRole(
      new Request("http://x/api", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "owner" }) }),
      memberCtx("m_guest_docs"),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/whole drive/);
    // unchanged
    const row = db.prepare("SELECT role FROM drive_members WHERE id='m_guest_docs'").get() as { role: string };
    expect(row.role).toBe("editor");
  });
});

describe("owner-role grants are creator-only (Q5)", () => {
  beforeAll(async () => {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
      .run("co1", "co@example.com", "CoOwner", "x");
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
      .run("plain1", "p@example.com", "Plain", "x");
    // creator grants co1 owner at root (allowed) + a plain viewer to target.
    db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)")
      .run("m_co1", "d1", "co1", "", "owner");
    db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)")
      .run("m_plain", "d1", "plain1", "", "viewer");
  });

  it("a co-owner cannot invite a new owner (403)", async () => {
    cookieJar.set("aindrive_session", await sign("co1"));
    const res = await inviteReq({ email: "p@example.com", path: "", role: "owner" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/creator/);
  });

  it("a co-owner cannot PATCH a member up to owner (403)", async () => {
    cookieJar.set("aindrive_session", await sign("co1"));
    const res = await changeRole(
      new Request("http://x/api", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "owner" }) }),
      memberCtx("m_plain"),
    );
    expect(res.status).toBe(403);
  });

  it("a co-owner cannot remove another owner (403)", async () => {
    cookieJar.set("aindrive_session", await sign("co1"));
    const { DELETE: removeMember } = await import("../../app/api/drives/[driveId]/members/[memberId]/route.js");
    // promote plain1 to owner first AS CREATOR so there are two owners.
    cookieJar.set("aindrive_session", await sign("owner1"));
    await changeRole(new Request("http://x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "owner" }) }), memberCtx("m_plain"));
    cookieJar.set("aindrive_session", await sign("co1"));
    const res = await removeMember(new Request("http://x", { method: "DELETE" }), memberCtx("m_plain"));
    expect(res.status).toBe(403);
    cookieJar.set("aindrive_session", await sign("owner1"));
  });

  it("the creator CAN grant + manage the owner role", async () => {
    cookieJar.set("aindrive_session", await sign("owner1"));
    // demote plain1 back to viewer (creator can change an owner)
    const res = await changeRole(new Request("http://x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "viewer" }) }), memberCtx("m_plain"));
    expect(res.status).toBe(200);
  });
});
